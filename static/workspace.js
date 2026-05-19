async function api(path,opts={}){
  // Strip leading slash so URL resolves relative to location.href (supports subpath mounts)
  const rel = path.startsWith('/') ? path.slice(1) : path;
  const url=new URL(rel,document.baseURI||location.href);
  // Retry up to 2 times on network errors (e.g. stale keep-alive after long idle).
  // Server errors (4xx/5xx) are NOT retried — only connection failures.
  let lastErr;
  for(let attempt=0;attempt<3;attempt++){
    try{
      const res=await fetch(url.href,{credentials:'include',headers:{'Content-Type':'application/json'},...opts});
      if(!res.ok){
        // 401 means the auth session expired. Redirect to login so the user can
        // re-authenticate. This is especially important for iOS PWA (standalone mode)
        // and for subpath mounts like /hermes/, where /login escapes to the site root.
        if(res.status===401){window.location.href='login?next='+encodeURIComponent(window.location.pathname+window.location.search);return;}
        const text=await res.text();
        // Parse JSON error body and surface the human-readable message,
        // rather than showing raw JSON like {"error":"Profile 'x' does not exist."}
        let message=text;
        try{const j=JSON.parse(text);message=j.error||j.message||text;}catch(e){}
        // Attach the raw HTTP context so callers can branch on status (404 stale-session
        // cleanup, 401 redirect, 503 retry, etc.) without re-parsing the message string.
        const err=new Error(message);
        err.status=res.status;
        err.statusText=res.statusText;
        err.body=text;
        throw err;
      }
      const ct=res.headers.get('content-type')||'';
      return ct.includes('application/json')?res.json():res.text();
    }catch(e){
      lastErr=e;
      // Only retry on network errors (TypeError from fetch), not on HTTP errors
      // that were already thrown above. Re-throw 401 redirects immediately.
      if(e.message&&/401/.test(e.message)) throw e;
      if(attempt<2 && e instanceof TypeError) continue;
      throw e;
    }
  }
  throw lastErr;
}

// Persist/restore expanded directory state per workspace in localStorage
function _wsExpandKey(){
  const ws=S.session&&S.session.workspace;
  return ws?'hermes-webui-expanded:'+ws:null;
}
function _saveExpandedDirs(){
  const key=_wsExpandKey();if(!key)return;
  try{localStorage.setItem(key,JSON.stringify([...(S._expandedDirs||new Set())]));}catch(e){}
}
function _restoreExpandedDirs(){
  const key=_wsExpandKey();
  if(!key){S._expandedDirs=new Set();return;}
  try{
    const raw=localStorage.getItem(key);
    S._expandedDirs=raw?new Set(JSON.parse(raw)):new Set();
  }catch(e){S._expandedDirs=new Set();}
}

async function loadDir(path){
  if(!S.session)return;
  try{
    if(!path||path==='.'){
      S._dirCache={};
      _restoreExpandedDirs();  // restore per-workspace expanded state on root load
    }
    S.currentDir=path||'.';
    const data=await api(`/api/list?session_id=${encodeURIComponent(S.session.session_id)}&path=${encodeURIComponent(path)}`);
    S.entries=data.entries||[];renderBreadcrumb();renderFileTree();
    // Pre-fetch contents of restored expanded dirs so they render without a second click
    // (parallelized — avoids serial waterfall when multiple dirs are expanded)
    if(!path||path==='.'){
      const expanded=S._expandedDirs||new Set();
      const pending=[...expanded].filter(dirPath=>!S._dirCache[dirPath]);
      if(pending.length){
        const results=await Promise.all(pending.map(dirPath=>
          api(`/api/list?session_id=${encodeURIComponent(S.session.session_id)}&path=${encodeURIComponent(dirPath)}`)
            .then(dc=>({dirPath,entries:dc.entries||[]}))
            .catch(()=>({dirPath,entries:[]}))
        ));
        for(const {dirPath,entries} of results) S._dirCache[dirPath]=entries;
      }
      if(expanded.size>0)renderFileTree();
    }
    if(typeof clearPreview==='function'){
      if(typeof _previewDirty!=='undefined'&&_previewDirty){
        showConfirmDialog({title:t('unsaved_confirm'),message:'',confirmLabel:'Discard',danger:true,focusCancel:true}).then(ok=>{if(ok)clearPreview({keepPanelOpen:true});});
      }else{
        clearPreview({keepPanelOpen:true});
      }
    }
    // Fetch git status for workspace root (non-blocking)
    if(!path||path==='.') refreshGitStatus();
  }catch(e){console.warn('loadDir',e);}
}

async function _refreshGitBadge(){
  return refreshGitStatus();
}

function _ensureGitState(){
  const scopeKey=`${(S.session&&S.session.session_id)||''}\n${(S.session&&S.session.workspace)||''}`;
  if(!S.git)S.git={status:null,selectedTab:'files',selectedDiff:null,loading:false,syncing:null,generatingCommitMessage:false,mutating:false,selectedPaths:new Set(),selectionTouched:false,selectionKey:scopeKey};
  if(typeof S.git.mutating==='undefined')S.git.mutating=false;
  if(typeof S.git.selectionTouched==='undefined')S.git.selectionTouched=false;
  if(!(S.git.selectedPaths instanceof Set)){
    S.git.selectedPaths=new Set(Array.isArray(S.git.selectedPaths)?S.git.selectedPaths:Object.keys(S.git.selectedPaths||{}).filter(k=>S.git.selectedPaths[k]));
  }
  if(S.git.selectionKey!==scopeKey){
    S.git.selectedPaths=new Set();
    S.git.selectionTouched=false;
    S.git.selectionKey=scopeKey;
  }
  return S.git;
}

function renderGitBadge(status){
  const badge=$('gitBadge');
  const tabs=$('workspaceGitTabs');
  if(!badge)return;
  if(!status||!status.is_git){
    badge.style.display='none';
    badge.textContent='';
    if(tabs)tabs.hidden=true;
    return;
  }
  if(tabs)tabs.hidden=false;
  const totals=status.totals||{};
  let text=status.branch||'git';
  if((totals.changed||0)>0) text+=` \u00b7 ${totals.changed}\u2206`;
  if(status.behind>0) text+=` \u2193${status.behind}`;
  if(status.ahead>0) text+=` \u2191${status.ahead}`;
  badge.textContent=text;
  badge.className='git-badge'+((totals.changed||0)>0?' dirty':'');
  badge.style.display='';
  const changesTab=$('btnWorkspaceChangesTab');
  if(changesTab){
    changesTab.textContent=(totals.changed||0)>0?`${t('git_changes')} ${totals.changed}`:t('git_changes');
  }
}

async function refreshGitStatus(){
  const git=_ensureGitState();
  if(!S.session){
    git.status=null;
    git.selectedTab='files';
    renderGitBadge(null);
    renderWorkspacePanelTabState();
    return null;
  }
  git.loading=true;
  try{
    const data=await api(`/api/git/status?session_id=${encodeURIComponent(S.session.session_id)}`);
    git.status=data.git||null;
    if(!git.status||!git.status.is_git)git.selectedTab='files';
    _reconcileGitSelection();
    renderGitBadge(git.status);
    renderGitChanges();
    if(typeof renderFileTree==='function')renderFileTree();
    return git.status;
  }catch(e){
    renderGitBadge(git.status);
    renderGitChanges();
    return git.status;
  }finally{
    git.loading=false;
    renderWorkspacePanelTabState();
  }
}

function renderWorkspacePanelTabState(){
  const git=_ensureGitState();
  const filesTab=$('btnWorkspaceFilesTab'), changesTab=$('btnWorkspaceChangesTab');
  const changesView=$('gitChangesView'), fileTree=$('fileTree'), emptyEl=$('wsEmptyState');
  const previewVisible=$('previewArea')&&$('previewArea').classList.contains('visible');
  if(filesTab)filesTab.classList.toggle('active',git.selectedTab!=='changes');
  if(changesTab)changesTab.classList.toggle('active',git.selectedTab==='changes');
  if(git.selectedTab==='changes'){
    if(fileTree)fileTree.style.display='none';
    if(emptyEl)emptyEl.style.display='none';
    if(changesView)changesView.style.display=previewVisible?'none':'flex';
  }else{
    if(changesView)changesView.style.display='none';
    if(fileTree&&!previewVisible)fileTree.style.display='';
  }
}

function switchWorkspacePanelTab(tab){
  const git=_ensureGitState();
  git.selectedTab=tab==='changes'?'changes':'files';
  if(git.selectedTab==='changes'){
    if($('previewArea'))$('previewArea').classList.remove('visible');
    git.selectedDiff=null;
    renderGitChanges();
  }
  renderWorkspacePanelTabState();
}

function _gitFiles(){
  const status=_ensureGitState().status;
  return (status&&Array.isArray(status.files))?status.files:[];
}

function _gitStatusForPath(path){
  return _gitFiles().find(f=>f.path===path)||null;
}

function _gitGroupFiles(kind){
  return _gitFiles().filter(f=>{
    if(kind==='conflicts')return f.conflict;
    if(kind==='tracked')return !f.untracked&&!f.conflict&&(f.staged||f.unstaged);
    if(kind==='staged')return f.staged&&!f.conflict;
    if(kind==='untracked')return f.untracked&&!f.conflict;
    return (f.unstaged&&!f.untracked&&!f.conflict);
  });
}

function _gitStageableFiles(){
  return _gitFiles().filter(f=>!f.conflict&&(f.unstaged||f.untracked));
}

function _gitCommittableFiles(){
  return _gitFiles().filter(f=>!f.conflict&&(f.staged||f.unstaged||f.untracked));
}

function _reconcileGitSelection(){
  const git=_ensureGitState();
  const selectable=_gitCommittableFiles();
  const allowed=new Set(selectable.map(f=>f.path));
  if(!git.selectionTouched){
    git.selectedPaths=new Set(selectable.filter(f=>f.staged&&!f.conflict).map(f=>f.path));
    return;
  }
  for(const path of [...git.selectedPaths]){
    if(!allowed.has(path))git.selectedPaths.delete(path);
  }
}

function _gitSelectedFiles(){
  const git=_ensureGitState();
  return _gitCommittableFiles().filter(f=>git.selectedPaths.has(f.path));
}

function _setGitPathSelected(path, selected){
  const git=_ensureGitState();
  git.selectionTouched=true;
  if(selected)git.selectedPaths.add(path);
  else git.selectedPaths.delete(path);
  renderGitChanges();
}

function _setGitGroupSelected(files, selected){
  const git=_ensureGitState();
  git.selectionTouched=true;
  for(const file of files){
    if(selected)git.selectedPaths.add(file.path);
    else git.selectedPaths.delete(file.path);
  }
  renderGitChanges();
}

function _setGitStatus(status){
  const git=_ensureGitState();
  git.status=status||null;
  _reconcileGitSelection();
  renderGitBadge(git.status);
  renderGitChanges();
  if(typeof renderFileTree==='function')renderFileTree();
}

function _gitStatsEl(file){
  const stats=document.createElement('span');
  stats.className='git-change-stats';
  if(file.binary){
    stats.textContent=t('git_binary_file');
    return stats;
  }
  const additions=document.createElement('span');
  additions.className='git-stat-add';
  additions.textContent=`+${file.additions||0}`;
  const deletions=document.createElement('span');
  deletions.className='git-stat-del';
  deletions.textContent=`-${file.deletions||0}`;
  stats.append(additions,' ',deletions);
  return stats;
}

function _gitGroupHeader(kind, label, files){
  const header=document.createElement('div');
  header.className='git-change-group-title';
  if(kind==='tracked'||kind==='untracked'){
    const selected=files.filter(f=>_ensureGitState().selectedPaths.has(f.path)).length;
    const checkbox=document.createElement('input');
    checkbox.type='checkbox';
    checkbox.className='git-select-checkbox git-select-group';
    checkbox.checked=selected>0&&selected===files.length;
    checkbox.indeterminate=selected>0&&selected<files.length;
    checkbox.disabled=!!_ensureGitState().mutating;
    checkbox.setAttribute('aria-label',`${label}: select ${files.length} file${files.length===1?'':'s'}`);
    checkbox.onclick=e=>{e.stopPropagation();_setGitGroupSelected(files,checkbox.checked);};
    header.appendChild(checkbox);
    const text=document.createElement('span');
    text.textContent=`${label} ${selected}/${files.length}`;
    header.appendChild(text);
  }else{
    header.textContent=label;
  }
  return header;
}

function _gitChangeRow(file, kind){
  const row=document.createElement('div');
  const selectable=kind==='tracked'||kind==='untracked';
  row.className='git-change-row'+(selectable?' selectable':'');
  row.tabIndex=0;
  row.onclick=()=>openGitDiff(file.path,(kind==='staged'||(kind==='tracked'&&file.staged&&!file.unstaged))?'staged':'unstaged');
  row.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();row.click();}};
  if(selectable){
    const checkbox=document.createElement('input');
    checkbox.type='checkbox';
    checkbox.className='git-select-checkbox';
    checkbox.checked=_ensureGitState().selectedPaths.has(file.path);
    checkbox.disabled=!!_ensureGitState().mutating;
    checkbox.setAttribute('aria-label',`Select ${file.path} for commit`);
    checkbox.onclick=e=>{e.stopPropagation();_setGitPathSelected(file.path,checkbox.checked);};
    row.appendChild(checkbox);
  }
  const status=document.createElement('span');
  status.className='git-change-status';
  status.textContent=file.status||'M';
  row.appendChild(status);
  const name=document.createElement('span');
  name.className='git-change-path';
  name.textContent=file.old_path?`${file.old_path} \u2192 ${file.path}`:file.path;
  row.appendChild(name);
  row.appendChild(_gitStatsEl(file));
  const actions=document.createElement('span');
  actions.className='git-change-actions';
  const mutating=!!_ensureGitState().mutating;
  const stagedOnly=(kind==='tracked'&&file.staged&&!file.unstaged&&!file.untracked);
  if(kind==='staged'||stagedOnly){
    const unstage=document.createElement('button');
    unstage.className='mini-btn';
    unstage.textContent=t('git_unstage');
    unstage.disabled=mutating;
    unstage.onclick=e=>{e.stopPropagation();unstageGitPath(file.path);};
    actions.appendChild(unstage);
  }else if(kind==='conflicts'){
    const open=document.createElement('button');
    open.className='mini-btn';
    open.textContent=t('open');
    open.onclick=e=>{e.stopPropagation();openFile(file.path,{returnTo:'changes'});};
    actions.appendChild(open);
  }else{
    const stage=document.createElement('button');
    stage.className='mini-btn';
    stage.textContent=t('git_stage');
    stage.disabled=mutating;
    stage.onclick=e=>{e.stopPropagation();stageGitPath(file.path);};
    actions.appendChild(stage);
    const discard=document.createElement('button');
    discard.className='mini-btn danger';
    discard.textContent=file.untracked?t('delete_title'):t('git_discard');
    discard.disabled=mutating;
    discard.onclick=e=>{e.stopPropagation();discardGitPath(file.path,{untracked:!!file.untracked});};
    actions.appendChild(discard);
  }
  row.appendChild(actions);
  return row;
}

function renderGitChanges(){
  const list=$('gitChangesList');
  const commitBox=$('gitCommitBox');
  const commitBtn=$('btnGitCommit');
  const generateBtn=$('btnGitGenerateCommitMessage');
  const selectionSummary=$('gitSelectionSummary');
  if(!list)return;
  list.innerHTML='';
  const status=_ensureGitState().status;
  if(!status||!status.is_git){
    const empty=document.createElement('div');
    empty.className='git-empty';
    empty.textContent=t('git_not_repo');
    list.appendChild(empty);
    if(commitBox)commitBox.style.display='none';
    renderWorkspacePanelTabState();
    return;
  }
  const summary=document.createElement('div');
  summary.className='git-summary';
  const totals=status.totals||{};
  const summaryText=document.createElement('span');
  summaryText.className='git-summary-text';
  summaryText.textContent=[status.branch||'HEAD',status.upstream,`${totals.changed||0} ${t('git_changed')}`,status.ahead?`\u2191${status.ahead}`:'',status.behind?`\u2193${status.behind}`:''].filter(Boolean).join(' \u00b7 ');
  summary.appendChild(summaryText);
  if(status.noise_filtering&&status.noise_filtering.active){
    const noise=document.createElement('span');
    noise.className='git-noise-note';
    noise.textContent=status.noise_filtering.message||'Metadata-only changes hidden';
    summary.appendChild(noise);
  }
  const summaryActions=document.createElement('span');
  summaryActions.className='git-summary-actions';
  for(const [action,label] of [['fetch',t('git_fetch')],['pull',t('git_pull')],['push',t('git_push')]]){
    const btn=document.createElement('button');
    btn.className='mini-btn git-sync-btn';
    btn.type='button';
    btn.textContent=label;
    btn.disabled=!!_ensureGitState().mutating||_ensureGitState().syncing===action;
    btn.onclick=()=>runGitRemoteAction(action);
    summaryActions.appendChild(btn);
  }
  const stageable=_gitStageableFiles();
  if(stageable.length){
    const stageAll=document.createElement('button');
    stageAll.className='mini-btn git-stage-all-btn';
    stageAll.type='button';
    stageAll.textContent=t('git_stage_all')||'Stage all';
    stageAll.disabled=!!_ensureGitState().mutating;
    stageAll.onclick=()=>stageGitAllChanges();
    summaryActions.appendChild(stageAll);
  }
  summary.appendChild(summaryActions);
  list.appendChild(summary);
  const groups=[
    ['conflicts',t('git_conflicts')],
    ['tracked',t('git_tracked')||'Tracked'],
    ['untracked',t('git_untracked')],
  ];
  let rendered=0;
  for(const [kind,label] of groups){
    const files=_gitGroupFiles(kind);
    if(!files.length)continue;
    const group=document.createElement('section');
    group.className='git-change-group';
    group.appendChild(_gitGroupHeader(kind,label,files));
    files.forEach(file=>group.appendChild(_gitChangeRow(file,kind)));
    list.appendChild(group);
    rendered+=files.length;
  }
  if(!rendered){
    const empty=document.createElement('div');
    empty.className='git-empty';
    empty.textContent=t('git_no_changes');
    list.appendChild(empty);
  }
  const selectedCount=_gitSelectedFiles().length;
  const committableCount=_gitCommittableFiles().length;
  if(commitBox)commitBox.style.display=committableCount?'flex':'none';
  if(selectionSummary){
    selectionSummary.textContent=selectedCount
      ? `${selectedCount} of ${committableCount} committable file${committableCount===1?'':'s'} selected`
      : `${committableCount} committable file${committableCount===1?'':'s'} available`;
  }
  const hasSelection=selectedCount>0;
  const generating=!!_ensureGitState().generatingCommitMessage;
  if(commitBtn){
    commitBtn.disabled=!hasSelection||generating||!!_ensureGitState().mutating;
    commitBtn.textContent=hasSelection?`${t('git_commit')} ${selectedCount} ${selectedCount===1?'file':'files'}`:t('git_commit');
  }
  if(generateBtn){
    generateBtn.disabled=!hasSelection||generating||!!_ensureGitState().mutating;
    generateBtn.textContent=generating?'Generating...':'Generate message';
  }
  renderWorkspacePanelTabState();
}

function navigateUp(){
  if(!S.session||S.currentDir==='.')return;
  const parts=S.currentDir.split('/');
  parts.pop();
  loadDir(parts.length?parts.join('/'):'.');
}

// File extension sets for preview routing (must match server-side sets)
const IMAGE_EXTS  = new Set(['.png','.jpg','.jpeg','.gif','.svg','.webp','.ico','.bmp']);
const MD_EXTS     = new Set(['.md','.markdown','.mdown']);
const HTML_EXTS   = new Set(['.html','.htm']);
const PDF_EXTS    = new Set(['.pdf']);
const AUDIO_EXTS  = new Set(['.mp3','.wav','.m4a','.aac','.ogg','.oga','.opus','.flac']);
const VIDEO_EXTS  = new Set(['.mp4','.mov','.m4v','.webm','.ogv','.avi','.mkv']);
// Binary formats that should download rather than preview
const DOWNLOAD_EXTS = new Set([
  '.docx','.doc','.xlsx','.xls','.pptx','.ppt','.odt','.ods','.odp',
  '.zip','.tar','.gz','.bz2','.7z','.rar',
  '.exe','.dmg','.pkg','.deb','.rpm',
  '.woff','.woff2','.ttf','.otf','.eot',
  '.bin','.dat','.db','.sqlite','.pyc','.class','.so','.dylib','.dll',
]);

function fileExt(p){ const i=p.lastIndexOf('.'); return i>=0?p.slice(i).toLowerCase():''; }

let _previewCurrentPath = '';  // relative path of currently previewed file
let _previewCurrentMode = '';  // 'code' | 'md' | 'image' | 'html' | 'pdf' | 'audio' | 'video'
let _previewDirty = false;     // true when edits are unsaved
let _previewReturnTarget = 'files'; // 'files' | 'changes'

function _setPreviewReturnTarget(target){
  _previewReturnTarget=target==='changes'?'changes':'files';
  const btn=$('btnPreviewBack');
  const label=$('previewBackLabel');
  if(label)label.textContent=_previewReturnTarget==='changes'?t('git_changes'):t('git_files');
  if(btn){
    btn.style.display='inline-flex';
    btn.title=_previewReturnTarget==='changes'?t('git_changes'):t('git_files');
  }
}

function showPreview(mode){
  // mode: 'code' | 'image' | 'md' | 'html' | 'pdf' | 'audio' | 'video' | 'gitdiff'
  $('previewCode').style.display     = mode==='code'  ? '' : 'none';
  $('previewImgWrap').style.display  = mode==='image' ? '' : 'none';
  const mediaWrap=$('previewMediaWrap'); if(mediaWrap) mediaWrap.style.display = (mode==='audio'||mode==='video') ? '' : 'none';
  const pdfWrap=$('previewPdfWrap'); if(pdfWrap) pdfWrap.style.display = mode==='pdf' ? '' : 'none';
  $('previewMd').style.display       = mode==='md'    ? '' : 'none';
  $('previewHtmlWrap').style.display = mode==='html'  ? '' : 'none';
  const diffView=$('gitDiffView'); if(diffView) diffView.style.display = mode==='gitdiff' ? 'flex' : 'none';
  $('previewEditArea').style.display = 'none';  // start in read-only
  const badge=$('previewBadge');
  badge.className='preview-badge '+mode;
  badge.textContent = mode==='image'?'image':mode==='audio'?'audio':mode==='video'?'video':mode==='pdf'?'pdf':mode==='md'?'md':mode==='html'?'html':mode==='gitdiff'?'diff':fileExt($('previewPathText').textContent)||'text';
  _previewCurrentMode = mode;
  _previewDirty = false;
  updateEditBtn();
  // Show "Open in browser" button for iframe-backed document previews
  const openBtn=$('btnOpenInBrowser');
  if(openBtn) openBtn.style.display = (mode==='html'||mode==='pdf')?'inline-flex':'none';
  const mdPopoutBtn=$('btnMarkdownPopout');
  if(mdPopoutBtn) mdPopoutBtn.style.display = mode==='md'?'inline-flex':'none';
  const downloadBtn=$('btnDownloadFile');
  if(downloadBtn) downloadBtn.style.display = mode==='gitdiff'?'none':'inline-flex';
}

function _closePreviewSurface(){
  const pa=$('previewArea');if(pa)pa.classList.remove('visible');
  const pi=$('previewImg');if(pi){pi.onerror=null;pi.src='';}
  const pdf=$('previewPdfFrame');if(pdf)pdf.src='';
  const html=$('previewHtmlIframe');if(html)html.src='';
  const pm=$('previewMd');if(pm)pm.innerHTML='';
  const pc=$('previewCode');if(pc)pc.textContent='';
  const pp=$('previewPathText');if(pp)pp.textContent='';
  const back=$('btnPreviewBack');if(back)back.style.display='none';
  _previewCurrentPath='';_previewCurrentMode='';_previewDirty=false;
}

async function returnFromPreview(){
  if(typeof _previewDirty!=='undefined'&&_previewDirty){
    const ok=await showConfirmDialog({title:t('unsaved_confirm'),message:'',confirmLabel:'Discard',danger:true,focusCancel:true});
    if(!ok)return;
  }
  if(_previewReturnTarget==='changes'){
    if(S.git){
      S.git.selectedTab='changes';
      S.git.selectedDiff=null;
    }
    _closePreviewSurface();
    renderGitChanges();
    renderWorkspacePanelTabState();
    return;
  }
  if(typeof clearPreview==='function')clearPreview({keepPanelOpen:true});
}

function updateEditBtn(){
  const btn=$('btnEditFile');
  if(!btn)return;
  const editable = _previewCurrentMode==='code'||_previewCurrentMode==='md';
  btn.style.display = editable?'':'none';
  const editing = $('previewEditArea').style.display!=='none';
  btn.innerHTML = editing ? `&#128190; ${t('save')}` : `&#9998; ${t('edit')}`;
  btn.title = editing ? t('save_title') : t('edit_title');
  btn.style.color = editing ? 'var(--blue)' : '';
  if(_previewDirty) btn.innerHTML = '&#128190; Save*';
}

async function toggleEditMode(){
  const editing = $('previewEditArea').style.display!=='none';
  if(editing){
    // Save
    if(!S.session||!_previewCurrentPath)return;
    const content=$('previewEditArea').value;
    try{
      await api('/api/file/save',{method:'POST',body:JSON.stringify({
        session_id:S.session.session_id, path:_previewCurrentPath, content
      })});
      _previewDirty=false;
      // Update read-only views
      if(_previewCurrentMode==='code') $('previewCode').textContent=content;
      else { renderWorkspaceMarkdown(content); }
      $('previewEditArea').style.display='none';
      if(_previewCurrentMode==='code') $('previewCode').style.display='';
      else $('previewMd').style.display='';
      showToast(t('saved'));
      refreshGitStatus();
    }catch(e){setStatus(t('save_failed')+e.message);}
  }else{
    // Enter edit mode: populate textarea with current content
    const currentText = _previewCurrentMode==='code'
      ? $('previewCode').textContent
      : _previewRawContent||'';
    $('previewEditArea').value=currentText;
    $('previewEditArea').style.display='';
    if(_previewCurrentMode==='code') $('previewCode').style.display='none';
    else $('previewMd').style.display='none';
    // Escape cancels the edit without saving
    $('previewEditArea').onkeydown=e=>{
      if(e.key==='Escape'){e.preventDefault();cancelEditMode();}
    };
  }
  updateEditBtn();
}

let _previewRawContent = '';  // raw text for md files (to populate editor)

function renderWorkspaceMarkdown(content){
  const target=$('previewMd');
  if(!target)return;
  target.innerHTML=renderMd(content||'');
  postProcessWorkspaceMarkdown(target);
}

function postProcessWorkspaceMarkdown(container){
  requestAnimationFrame(()=>{
    if(typeof postProcessRenderedMessages==='function')postProcessRenderedMessages(container);
    else{
      if(typeof highlightCode==='function')highlightCode(container);
      if(typeof addCopyButtons==='function')addCopyButtons(container);
      if(typeof renderMermaidBlocks==='function')renderMermaidBlocks(container);
      if(typeof renderKatexBlocks==='function')renderKatexBlocks(container);
      if(typeof initTreeViews==='function')initTreeViews(container);
    }
  });
}

function cancelEditMode(){
  // Discard changes and return to read-only view
  $('previewEditArea').style.display='none';
  $('previewEditArea').onkeydown=null;
  if(_previewCurrentMode==='code') $('previewCode').style.display='';
  else $('previewMd').style.display='';
  _previewDirty=false;
  updateEditBtn();
}

async function openFile(path,opts={}){
  if(!S.session)return;
  const ext=fileExt(path);

  // Binary/download-only formats: trigger browser download, don't preview
  if(DOWNLOAD_EXTS.has(ext)){
    downloadFile(path);
    return;
  }

  $('previewPathText').textContent=path;
  $('previewArea').classList.add('visible');
  $('fileTree').style.display='none';
  const returnTarget=opts.returnTo||(S.git&&S.git.selectedTab==='changes'?'changes':'files');
  _setPreviewReturnTarget(returnTarget);

  _previewCurrentPath = path;
  renderFileBreadcrumb(path);
  if(IMAGE_EXTS.has(ext)){
    // Image: load via raw endpoint, show as <img>
    showPreview('image');
    const url=`api/file/raw?session_id=${encodeURIComponent(S.session.session_id)}&path=${encodeURIComponent(path)}`;
    $('previewImg').alt=path;
    $('previewImg').src=url;
    $('previewImg').onerror=()=>setStatus(t('image_load_failed'));
  } else if(AUDIO_EXTS.has(ext)||VIDEO_EXTS.has(ext)){
    const mode=VIDEO_EXTS.has(ext)?'video':'audio';
    showPreview(mode);
    const url=`api/file/raw?session_id=${encodeURIComponent(S.session.session_id)}&path=${encodeURIComponent(path)}&inline=1`;
    const wrap=$('previewMediaWrap');
    if(wrap){
      wrap.innerHTML=(typeof _mediaPlayerHtml==='function')
        ? _mediaPlayerHtml(mode,url,path.split('/').pop()||path)
        : `<${mode} src="${url.replace(/"/g,'%22')}" controls preload="metadata"></${mode}>`;
      if(typeof _applyMediaPlaybackPreferences==='function') _applyMediaPlaybackPreferences(wrap);
    }
  } else if(PDF_EXTS.has(ext)){
    showPreview('pdf');
    const url=`api/file/raw?session_id=${encodeURIComponent(S.session.session_id)}&path=${encodeURIComponent(path)}&inline=1`;
    const frame=$('previewPdfFrame');
    if(frame){
      frame.src=''; // clear first to avoid stale content
      frame.src=url;
      frame.title=`PDF preview: ${path.split('/').pop()||path}`;
    }
  } else if(MD_EXTS.has(ext)){
    // Markdown: fetch text, render with renderMd, display as formatted HTML
    try{
      const data=await api(`/api/file?session_id=${encodeURIComponent(S.session.session_id)}&path=${encodeURIComponent(path)}`);
      showPreview('md');
      _previewRawContent = data.content;
      renderWorkspaceMarkdown(data.content);
    }catch(e){setStatus(t('file_open_failed'));}
  } else if(HTML_EXTS.has(ext)){
    // HTML: render in sandboxed iframe via raw endpoint.
    // SECURITY TRADEOFF: We use sandbox="allow-scripts" which lets inline JS run
    // but prevents access to the parent frame (origin isolation). This is a
    // deliberate choice — the user is previewing their own workspace files, so
    // blocking scripts entirely would break most HTML documents. The sandbox
    // still prevents the preview from navigating the parent, accessing cookies,
    // or reading other origin data. If a stricter mode is needed, remove
    // allow-scripts (or add sandbox="") to disable all JS execution.
    showPreview('html');
    const url=`api/file/raw?session_id=${encodeURIComponent(S.session.session_id)}&path=${encodeURIComponent(path)}&inline=1`;
    const iframe=$('previewHtmlIframe');
    if(iframe){
      iframe.src=''; // clear first to avoid stale content
      iframe.src=url;
    }
  } else {
    // Plain code / text -- but fall back to download if server signals binary
    try{
      const data=await api(`/api/file?session_id=${encodeURIComponent(S.session.session_id)}&path=${encodeURIComponent(path)}`);
      if(data.binary){
        // Server flagged this as binary content
        downloadFile(path);
        return;
      }
      showPreview('code');
      $('previewCode').textContent=data.content;
    }catch(e){
      // If it's a 400/too-large error, offer download instead
      downloadFile(path);
    }
  }
}

function downloadFile(path){
  if(!S.session)return;
  // Trigger browser download via the raw file endpoint with content-disposition attachment
  const url=`api/file/raw?session_id=${encodeURIComponent(S.session.session_id)}&path=${encodeURIComponent(path)}&download=1`;
  const filename=path.split('/').pop();
  const a=document.createElement('a');
  a.href=url;a.download=filename;
  document.body.appendChild(a);a.click();
  setTimeout(()=>document.body.removeChild(a),100);
  showToast(t('downloading',filename),2000);
}


// ── Render breadcrumb for file preview mode ──────────────────────────────────
function renderFileBreadcrumb(filePath) {
  const bar = $('breadcrumbBar');
  if (!bar) return;
  bar.style.display = 'flex';
  const upBtn = $('btnUpDir');
  if (upBtn) upBtn.style.display = '';

  bar.innerHTML = '';
  // Root
  const root = document.createElement('span');
  root.className = 'breadcrumb-seg breadcrumb-link';
  root.textContent = '~';
  root.onclick = () => { loadDir('.'); };
  bar.appendChild(root);

  const parts = filePath.split('/');
  let accumulated = '';
  for (let i = 0; i < parts.length; i++) {
    const sep = document.createElement('span');
    sep.className = 'breadcrumb-sep';
    sep.textContent = '/';
    bar.appendChild(sep);

    accumulated += (accumulated ? '/' : '') + parts[i];
    const seg = document.createElement('span');
    seg.textContent = parts[i];
    if (i < parts.length - 1) {
      seg.className = 'breadcrumb-seg breadcrumb-link';
      const target = accumulated;
      seg.onclick = () => { loadDir(target); };
    } else {
      seg.className = 'breadcrumb-seg breadcrumb-current';
    }
    bar.appendChild(seg);
  }
}

function openInBrowser(){
  if(!_previewCurrentPath||!S.session) return;
  const url=`api/file/raw?session_id=${encodeURIComponent(S.session.session_id)}&path=${encodeURIComponent(_previewCurrentPath)}`;
  window.open(url,'_blank');
}

function openMarkdownPopout(){
  if(_previewCurrentMode!=='md'||!_previewCurrentPath)return;
  const bodyHtml=$('previewMd')?$('previewMd').innerHTML:'';
  const title=(_previewCurrentPath.split('/').pop()||_previewCurrentPath).replace(/[<>&"]/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c]));
  const html=`<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>
    :root{color-scheme:dark light;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;background:#11100e;color:#eae0d5}
    body{margin:0;padding:28px;line-height:1.7}
    main{max-width:920px;margin:0 auto}
    pre{overflow:auto;padding:12px;border:1px solid rgba(255,255,255,.14);border-radius:8px;background:rgba(0,0,0,.24)}
    code{font-family:"SF Mono",ui-monospace,monospace}
    table{border-collapse:collapse;width:100%;margin:12px 0}th,td{border:1px solid rgba(255,255,255,.16);padding:6px 10px;text-align:left}
    a{color:#8ab4f8} img{max-width:100%;height:auto}
  </style></head><body><main class="preview-md">${bodyHtml}</main></body></html>`;
  const url=URL.createObjectURL(new Blob([html],{type:'text/html'}));
  window.open(url,'_blank','noopener,noreferrer');
  setTimeout(()=>URL.revokeObjectURL(url),60000);
}

async function openGitDiff(path,kind='unstaged'){
  if(!S.session)return;
  const git=_ensureGitState();
  git.selectedTab='changes';
  git.selectedDiff={path,kind};
  $('previewPathText').textContent=`Changes / ${path}`;
  $('previewArea').classList.add('visible');
  $('fileTree').style.display='none';
  _setPreviewReturnTarget('changes');
  const changesView=$('gitChangesView'); if(changesView) changesView.style.display='none';
  const diffView=$('gitDiffView');
  if(diffView){
    diffView.innerHTML='';
    const loading=document.createElement('div');
    loading.className='git-empty';
    loading.textContent='Loading diff...';
    diffView.appendChild(loading);
  }
  _previewCurrentPath=path;
  showPreview('gitdiff');
  renderWorkspacePanelTabState();
  try{
    const data=await api(`/api/git/diff?session_id=${encodeURIComponent(S.session.session_id)}&path=${encodeURIComponent(path)}&kind=${encodeURIComponent(kind)}`);
    renderGitDiff(data.diff);
  }catch(e){
    if(diffView){
      diffView.innerHTML='';
      const err=document.createElement('div');
      err.className='git-empty error';
      err.textContent=e.message||t('git_commit_failed');
      diffView.appendChild(err);
    }
  }
}

function renderGitDiff(diff){
  const view=$('gitDiffView');
  if(!view)return;
  view.innerHTML='';
  if(!diff)return;
  if(diff.binary){
    const msg=document.createElement('div');
    msg.className='git-empty';
    msg.textContent=t('git_binary_file');
    view.appendChild(msg);
    return;
  }
  if(diff.too_large){
    const msg=document.createElement('div');
    msg.className='git-diff-warning';
    msg.textContent=t('git_diff_too_large');
    view.appendChild(msg);
  }
  const text=diff.diff||'';
  if(!text.trim()){
    const msg=document.createElement('div');
    msg.className='git-empty';
    msg.textContent=t('git_no_changes');
    view.appendChild(msg);
    return;
  }
  const actions=document.createElement('div');
  actions.className='git-diff-actions';
  const state=_gitStatusForPath(diff.path);
  if(diff.kind==='staged'){
    const unstage=document.createElement('button');
    unstage.className='mini-btn';
    unstage.textContent=t('git_unstage');
    unstage.onclick=()=>unstageGitPath(diff.path);
    actions.appendChild(unstage);
  }else{
    const stage=document.createElement('button');
    stage.className='mini-btn';
    stage.textContent=t('git_stage');
    stage.onclick=()=>stageGitPath(diff.path);
    actions.appendChild(stage);
    if(state){
      const discard=document.createElement('button');
      discard.className='mini-btn danger';
      discard.textContent=state.untracked?t('delete_title'):t('git_discard');
      discard.onclick=()=>discardGitPath(diff.path,{untracked:!!state.untracked});
      actions.appendChild(discard);
    }
  }
  const open=document.createElement('button');
  open.className='mini-btn';
  open.textContent=t('open_file');
  open.onclick=()=>openFile(diff.path,{returnTo:'changes'});
  actions.appendChild(open);
  view.appendChild(actions);
  for(const lineText of text.split('\n')){
    const line=document.createElement('div');
    line.className='git-diff-line';
    if(lineText.startsWith('@@'))line.classList.add('git-diff-hunk');
    else if(lineText.startsWith('+')&&!lineText.startsWith('+++'))line.classList.add('git-diff-add');
    else if(lineText.startsWith('-')&&!lineText.startsWith('---'))line.classList.add('git-diff-del');
    else if(lineText.startsWith('diff --git')||lineText.startsWith('index ')||lineText.startsWith('---')||lineText.startsWith('+++'))line.classList.add('git-diff-meta');
    line.textContent=lineText||' ';
    view.appendChild(line);
  }
}

async function stageGitPath(path){
  if(!S.session)return;
  const git=_ensureGitState();
  git.mutating=true;renderGitChanges();
  try{
    const data=await api('/api/git/stage',{method:'POST',body:JSON.stringify({session_id:S.session.session_id,paths:[path]})});
    _setGitStatus(data.git);
    if(S.git.selectedDiff&&S.git.selectedDiff.path===path)openGitDiff(path,'staged');
  }catch(e){showToast(e.message||t('git_commit_failed'),3000,'error');}
  finally{git.mutating=false;renderGitChanges();}
}

async function stageGitAllChanges(){
  if(!S.session)return;
  const paths=_gitStageableFiles().map(f=>f.path);
  if(!paths.length)return;
  const git=_ensureGitState();
  git.mutating=true;renderGitChanges();
  try{
    const data=await api('/api/git/stage',{method:'POST',body:JSON.stringify({session_id:S.session.session_id,paths})});
    _setGitStatus(data.git);
    if(S.git.selectedDiff&&paths.includes(S.git.selectedDiff.path))openGitDiff(S.git.selectedDiff.path,'staged');
  }catch(e){showToast(e.message||t('git_commit_failed'),3000,'error');}
  finally{git.mutating=false;renderGitChanges();}
}

async function unstageGitPath(path){
  if(!S.session)return;
  const git=_ensureGitState();
  git.mutating=true;renderGitChanges();
  try{
    const data=await api('/api/git/unstage',{method:'POST',body:JSON.stringify({session_id:S.session.session_id,paths:[path]})});
    _setGitStatus(data.git);
    if(S.git.selectedDiff&&S.git.selectedDiff.path===path)openGitDiff(path,'unstaged');
  }catch(e){showToast(e.message||t('git_commit_failed'),3000,'error');}
  finally{git.mutating=false;renderGitChanges();}
}

async function discardGitPath(path,opts={}){
  if(!S.session)return;
  const untracked=!!opts.untracked;
  const ok=await showConfirmDialog({
    title:untracked?t('delete_confirm',path):t('git_discard_confirm_title'),
    message:untracked?t('git_delete_untracked_confirm',path):t('git_discard_confirm_message',path),
    confirmLabel:untracked?t('delete_title'):t('git_discard'),
    danger:true,
    focusCancel:true
  });
  if(!ok)return;
  const git=_ensureGitState();
  git.mutating=true;renderGitChanges();
  try{
    const data=await api('/api/git/discard',{method:'POST',body:JSON.stringify({session_id:S.session.session_id,paths:[path],delete_untracked:untracked})});
    _setGitStatus(data.git);
    if(S.git.selectedDiff&&S.git.selectedDiff.path===path){
      $('previewArea').classList.remove('visible');
      S.git.selectedDiff=null;
      renderWorkspacePanelTabState();
    }
    await loadDir(S.currentDir);
  }catch(e){showToast(e.message||t('git_commit_failed'),3000,'error');}
  finally{git.mutating=false;renderGitChanges();}
}

async function commitGitChanges(){
  if(!S.session)return;
  const input=$('gitCommitMessage');
  const message=(input&&input.value||'').trim();
  if(!message){showToast(t('git_commit_message'),2200);return;}
  const selected=_gitSelectedFiles().map(f=>f.path);
  if(!selected.length){showToast(t('git_select_files')||'Select files to commit',2200);return;}
  const git=_ensureGitState();
  git.mutating=true;renderGitChanges();
  try{
    const data=await api('/api/git/commit-selected',{method:'POST',body:JSON.stringify({session_id:S.session.session_id,message,paths:selected})});
    if(input)input.value='';
    _setGitStatus(data.status);
    showToast(`${t('git_committed')} ${data.commit}`,2600);
    await loadDir(S.currentDir);
  }catch(e){showToast(`${t('git_commit_failed')}: ${e.message}`,4000,'error');}
  finally{git.mutating=false;renderGitChanges();}
}

async function generateGitCommitMessage(){
  if(!S.session)return;
  const git=_ensureGitState();
  if(git.generatingCommitMessage)return;
  const selected=_gitSelectedFiles().map(f=>f.path);
  if(!selected.length){showToast(t('git_select_files')||'Select files to commit',2200);return;}
  git.generatingCommitMessage=true;
  renderGitChanges();
  try{
    const data=await api('/api/git/commit-message-selected',{method:'POST',body:JSON.stringify({session_id:S.session.session_id,paths:selected})});
    const input=$('gitCommitMessage');
    if(input){
      input.value=data.message||'';
      input.focus();
      input.selectionStart=input.selectionEnd=input.value.length;
    }
    if(data.truncated)showToast('Generated from a truncated selected diff',3200);
  }catch(e){
    showToast(`Commit message generation failed: ${e.message}`,4000,'error');
  }finally{
    git.generatingCommitMessage=false;
    renderGitChanges();
  }
}

async function runGitRemoteAction(action){
  if(!S.session||!['fetch','pull','push'].includes(action))return;
  const git=_ensureGitState();
  git.syncing=action;
  git.mutating=true;
  renderGitChanges();
  try{
    const data=await api(`/api/git/${action}`,{method:'POST',body:JSON.stringify({session_id:S.session.session_id})});
    _setGitStatus(data.status);
    const label=action==='fetch'?t('git_fetched'):action==='pull'?t('git_pulled'):t('git_pushed');
    showToast(data.message?`${label}: ${data.message}`:label,3600);
    await loadDir(S.currentDir);
  }catch(e){
    showToast(`${t('git_sync_failed')}: ${e.message}`,4000,'error');
  }finally{
    git.syncing=null;
    git.mutating=false;
    renderGitChanges();
  }
}
