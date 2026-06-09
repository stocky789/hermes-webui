async function api(path,opts={}){
  // Strip leading slash so URL resolves relative to location.href (supports subpath mounts)
  const rel = path.startsWith('/') ? path.slice(1) : path;
  const url=new URL(rel,document.baseURI||location.href);
  const timeoutMs=Object.prototype.hasOwnProperty.call(opts,'timeoutMs')?opts.timeoutMs:30000;
  const timeoutToast=opts.timeoutToast!==false;
  // Retry up to 2 times on network errors (e.g. stale keep-alive after long idle).
  // Server errors (4xx/5xx) and client-side timeouts are NOT retried.
  let lastErr;
  for(let attempt=0;attempt<3;attempt++){
    let controller=null;
    let timeoutId=null;
    let didTimeout=false;
    let upstreamSignal=null;
    let upstreamAbort=null;
    try{
      const fetchOpts={...opts};
      delete fetchOpts.timeoutMs;
      delete fetchOpts.timeoutToast;

      const useTimeout=Number.isFinite(Number(timeoutMs))&&Number(timeoutMs)>0;
      if(useTimeout&&typeof AbortController!=='undefined'){
        controller=new AbortController();
        upstreamSignal=fetchOpts.signal||null;
        if(upstreamSignal){
          upstreamAbort=()=>controller.abort(upstreamSignal.reason);
          if(upstreamSignal.aborted) upstreamAbort();
          else upstreamSignal.addEventListener('abort',upstreamAbort,{once:true});
        }
        fetchOpts.signal=controller.signal;
      }
      const requestPromise=(async()=>{
        const res=await fetch(url.href,{credentials:'include',headers:{'Content-Type':'application/json'},...fetchOpts});
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
        return ct.includes('application/json')?await res.json():await res.text();
      })();
      return useTimeout?await Promise.race([
        requestPromise,
        new Promise((_,reject)=>{
          timeoutId=setTimeout(()=>{
            didTimeout=true;
            if(controller) controller.abort();
            const err=new Error('Request timed out. Please try again.');
            err.name='TimeoutError';
            err.timeout=true;
            reject(err);
          },Number(timeoutMs));
        })
      ]):await requestPromise;
    }catch(e){
      lastErr=e;
      const isTimeout=didTimeout||(e&&(e.timeout===true||e.name==='TimeoutError'));
      if(isTimeout){
        const err=(e&&e.name==='TimeoutError')?e:new Error('Request timed out. Please try again.');
        err.name='TimeoutError';
        err.timeout=true;
        if(timeoutToast&&typeof showToast==='function') showToast('Request timed out. Please try again.',5000,'error');
        throw err;
      }
      // Only retry on network errors (TypeError from fetch), not on HTTP errors
      // that were already thrown above. Re-throw 401 redirects immediately.
      if(e.message&&/401/.test(e.message)) throw e;
      if(attempt<2 && e instanceof TypeError) continue;
      throw e;
    }finally{
      if(timeoutId) clearTimeout(timeoutId);
      if(upstreamSignal&&upstreamAbort) upstreamSignal.removeEventListener('abort',upstreamAbort);
    }
  }
  throw lastErr;
}

function recordClientSSEError(source, details={}){
  try{
    const payload={
      event:'sse_error',
      source:String(source||'unknown'),
      ready_state:details.ready_state,
      session_id:details.session_id||null,
      stream_id:details.stream_id||null,
      visibility_state:(typeof document!=='undefined'&&document.visibilityState)||'unknown',
      online:(typeof navigator!=='undefined'&&typeof navigator.onLine==='boolean')?navigator.onLine:null,
      url_path:(typeof location!=='undefined'&&location.pathname)||'/',
      reason:details.reason||'EventSource.onerror',
    };
    void api('/api/client-events/log',{method:'POST',body:JSON.stringify(payload),timeoutMs:3000,timeoutToast:false}).catch(()=>{});
  }catch(_){}
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

let _workspacePanelActiveTab = 'files';
let _renderSessionArtifactsTimer = null;

function _setWorkspacePanelTabDataset(){
  const panel = document.querySelector('.rightpanel');
  if(panel) panel.dataset.activeTab = _workspacePanelActiveTab;
}

function scheduleRenderSessionArtifacts(){
  if(_renderSessionArtifactsTimer) clearTimeout(_renderSessionArtifactsTimer);
  _renderSessionArtifactsTimer = setTimeout(()=>{
    _renderSessionArtifactsTimer = null;
    renderSessionArtifacts();
  }, 100);
}

if(typeof document !== 'undefined'){
  if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', _setWorkspacePanelTabDataset, {once:true});
  else _setWorkspacePanelTabDataset();
}

function switchWorkspacePanelTab(tab){
  _workspacePanelActiveTab = tab === 'artifacts' ? 'artifacts' : 'files';
  _setWorkspacePanelTabDataset();
  const filesTab = $('workspaceFilesTab');
  const artifactsTab = $('workspaceArtifactsTab');
  if(filesTab){
    filesTab.classList.toggle('active', _workspacePanelActiveTab === 'files');
    filesTab.setAttribute('aria-selected', _workspacePanelActiveTab === 'files' ? 'true' : 'false');
  }
  if(artifactsTab){
    artifactsTab.classList.toggle('active', _workspacePanelActiveTab === 'artifacts');
    artifactsTab.setAttribute('aria-selected', _workspacePanelActiveTab === 'artifacts' ? 'true' : 'false');
  }
  const artifacts = $('workspaceArtifacts');
  if(artifacts) artifacts.hidden = _workspacePanelActiveTab !== 'artifacts';
  if(_workspacePanelActiveTab === 'artifacts') renderSessionArtifacts();
}

const ARTIFACT_IGNORE_RE = /(^|\/)(?:\.git|\.hg|\.svn|node_modules|\.venv|venv|__pycache__|dist|build|\.next|\.cache)(?:\/|$)/;
// Canonical Hermes mutators plus MCP filesystem aliases that can create/edit files.
const ARTIFACT_MUTATION_TOOLS = new Set(['write_file','patch','edit_file','create_file','mcp_filesystem_write_file','mcp_filesystem_edit_file']);

function _normalizeArtifactPath(path){
  if(!path) return '';
  path = String(path).trim().replace(/[\`"'<>),.;:]+$/g,'').replace(/^[\`"'(<]+/g,'');
  if(!path || path.length > 240 || path.includes('://')) return '';
  // Canonicalize workspace-relative prefixes so a file-tree open ("foo.md") and a
  // tool arg recorded as "./foo.md" or "~/foo.md" compare equal for mutation
  // tracking; otherwise an agent edit via a ./-prefixed path leaves the open
  // preview stale (#3262 / pre-release regression-gate finding).
  path = path.replace(/^~\//,'').replace(/^(?:\.\/)+/,'');
  if(!path) return '';
  if(ARTIFACT_IGNORE_RE.test(path)) return '';
  if(!/[./]/.test(path)) return '';
  return path;
}

function _artifactCandidatesFromText(text){
  if(!text || typeof text !== 'string') return [];
  const out = [];
  const seen = new Set();
  const add = (path) => {
    path = _normalizeArtifactPath(path);
    if(!path || seen.has(path)) return;
    seen.add(path); out.push({path, kind:'diff'});
  };
  // Fallback text mining is intentionally narrow: only diff/patch fences imply
  // the session changed a file. Prose mentions such as "edited package.json" are
  // too noisy for an Artifacts list that should track write/edit outputs.
  const fenced = /```(?:diff|patch)\s*\n[\s\S]*?```/gi;
  let m;
  while((m = fenced.exec(text))){
    const block = m[0];
    const fm = block.match(/(?:^|\n)(?:\+\+\+|---)\s+(?:[ab]\/)?([^\n\t]+)/);
    if(fm) add(fm[1].trim());
  }
  return out;
}

function _artifactCandidatesFromToolCall(tc){
  if(!tc) return [];
  const name = String(tc.name || '').replace(/^functions\./,'');
  const args = tc.arguments || tc.args || tc.input || {};
  const result = tc.result || tc.output || tc.snippet || '';
  const out = [];
  const add = (path, source=name || 'tool') => {
    path = _normalizeArtifactPath(path);
    if(path) out.push({path, kind:source});
  };
  if(ARTIFACT_MUTATION_TOOLS.has(name) && args && typeof args === 'object'){
    for(const key of ['path','file_path','source','destination']) add(args[key]);
    if(Array.isArray(args.paths)) args.paths.forEach(p=>add(p));
    if(Array.isArray(args.edits)) args.edits.forEach(e=>add(e&&e.path));
  }
  const resultText = typeof result === 'string' ? result : (result ? JSON.stringify(result) : '');
  // Tool results may include unified diffs from patch-style tools; scan those
  // narrowly after structured args so diff headers can still contribute paths.
  for(const a of _artifactCandidatesFromText(resultText)) out.push(a);
  if(!out.length && ARTIFACT_MUTATION_TOOLS.has(name)){
    const argsText = typeof args === 'string' ? args : JSON.stringify(args || {});
    for(const a of _artifactCandidatesFromText(argsText)) out.push(a);
  }
  return out;
}

const _turnMutatedPreviewPaths = new Set();

function resetTurnWorkspaceMutations(){
  _turnMutatedPreviewPaths.clear();
}

function noteWorkspaceMutationsFromToolCall(tc){
  for(const a of _artifactCandidatesFromToolCall(tc)){
    const path=_normalizeArtifactPath(a.path);
    if(path) _turnMutatedPreviewPaths.add(path);
  }
}

function noteWorkspaceMutationsFromToolCalls(toolCalls){
  if(!Array.isArray(toolCalls)) return;
  for(const tc of toolCalls) noteWorkspaceMutationsFromToolCall(tc);
}

function _isOpenPreviewPathMutated(){
  if(!_previewCurrentPath) return false;
  const current=_normalizeArtifactPath(_previewCurrentPath);
  return !!(current&&_turnMutatedPreviewPaths.has(current));
}

async function refreshOpenPreviewIfMutated(){
  if(typeof _previewDirty!=='undefined'&&_previewDirty) return;
  if(!_isOpenPreviewPathMutated()) return;
  if(!_previewCurrentPath||!S.session) return;
  await openFile(_previewCurrentPath, { bustCache: true });
}

function collectSessionArtifacts(){
  const items = [];
  const seen = new Set();
  const push = (path, source) => {
    path = _normalizeArtifactPath(path);
    if(!path || seen.has(path)) return;
    seen.add(path); items.push({path, source});
  };
  // Source 1: session-level tool call summaries (may be empty when messages
  // carry their own tool metadata — see _syncToolCallsForLoadedMessages).
  for(const tc of (S.toolCalls || [])){
    for(const a of _artifactCandidatesFromToolCall(tc)) push(a.path, a.kind || tc.name || 'tool');
  }
  // Source 2 & 3: message-level data — both text-mined diffs and structured
  // tool_calls / tool_use content blocks that survive the S.toolCalls clear.
  for(const msg of (S.messages || [])){
    if(!msg) continue;
    const text = msg.content || msg.text || msg.message || '';
    // Text-mined diff/patch fences (existing path).
    if(typeof text === 'string'){
      for(const a of _artifactCandidatesFromText(text)) push(a.path, a.kind);
    }
    // Structured tool_calls array (OpenAI format: {function:{name,arguments}}).
    if(Array.isArray(msg.tool_calls)){
      for(const tc of msg.tool_calls){
        if(!tc || typeof tc !== 'object') continue;
        const fn = (tc.function && typeof tc.function === 'object') ? tc.function : tc;
        const name = fn.name || tc.name || '';
        let args = fn.arguments || tc.arguments || tc.args || tc.input || {};
        if(typeof args === 'string'){ try{ args = JSON.parse(args); }catch(_){} }
        const fakeTc = {name, args, result: tc.result || tc.output || ''};
        for(const a of _artifactCandidatesFromToolCall(fakeTc)) push(a.path, a.kind || name || 'tool');
      }
    }
    // Structured content array with tool_use blocks (Anthropic format).
    if(Array.isArray(msg.content)){
      for(const block of msg.content){
        if(!block || block.type !== 'tool_use') continue;
        let inp = block.input || {};
        if(typeof inp === 'string'){ try{ inp = JSON.parse(inp); }catch(_){} }
        const fakeTc = {name: block.name || '', args: inp, result: block.result || ''};
        for(const a of _artifactCandidatesFromToolCall(fakeTc)) push(a.path, a.kind || block.name || 'tool');
      }
    }
  }
  return items.slice(0, 50);
}

function renderSessionArtifacts(){
  const root = $('workspaceArtifacts');
  const count = $('workspaceArtifactsCount');
  if(!root) return;
  const items = collectSessionArtifacts();
  if(count) count.textContent = String(items.length);
  if(!S.session){
    root.innerHTML = '<div class="workspace-artifact-empty">Open a conversation to see files changed in this session.</div>';
    return;
  }
  if(!items.length){
    root.innerHTML = '<div class="workspace-artifact-empty">No artifacts detected yet. Files created or edited during this session will appear here.</div>';
    return;
  }
  // Strip workspace prefix for display so long absolute paths don't clutter the list.
  const ws = S.session && S.session.workspace;
  const normWs = ws ? ws.replace(/\/+$/,'') + '/' : '';
  const displayPath = (p) => {
    if(normWs && p.startsWith(normWs)) return p.slice(normWs.length);
    return p;
  };
  root.innerHTML = items.map(item => `<button type="button" class="workspace-artifact-item" data-artifact-path="${esc(item.path)}" onclick="openArtifactPath(this.dataset.artifactPath)"><div class="workspace-artifact-path">${esc(displayPath(item.path))}</div><div class="workspace-artifact-meta">${esc(item.source || 'session')}</div></button>`).join('');
}

async function _workspacePathExists(path){
  if(!S.session||!path) return false;
  const parts=String(path).split('/').filter(Boolean);
  const name=parts.pop();
  if(!name) return false;
  const dir=parts.length?parts.join('/'):'.';
  const data=await api(`/api/list?session_id=${encodeURIComponent(S.session.session_id)}&path=${encodeURIComponent(dir)}`);
  return (data.entries||[]).some(entry=>entry&&((entry.path===path)||entry.name===name));
}

async function openArtifactPath(path){
  if(!path) return;
  switchWorkspacePanelTab('files');
  let rel = path.replace(/^~\//,'').replace(/^\.\/+/,'');
  // Strip workspace prefix so /api/list receives a workspace-relative path.
  const ws = S.session && S.session.workspace;
  if(ws){
    const normWs = ws.replace(/\/+$/,'') + '/';
    if(rel.startsWith(normWs)) rel = rel.slice(normWs.length);
    else if(rel === ws.replace(/\/+$/,'')) rel = '.';
  }
  if(!rel) rel = '.';
  try{
    if(!(await _workspacePathExists(rel))){
      setStatus(t('file_open_failed'));
      return;
    }
  }catch(_){
    setStatus(t('file_open_failed'));
    return;
  }
  openFile(rel);
}

async function loadDir(path, opts={}){
  const preservePreview=!!(opts&&opts.preservePreview);
  if(!S.session)return;
  const sessionId=S.session.session_id;
  try{
    const dirPath=_normalizeWorkspaceDirPath(path);
    if(dirPath==='.'){
      S._dirCache={};
      S._dirSignatures={};
      _restoreExpandedDirs();  // restore per-workspace expanded state on root load
    }
    S.currentDir=path||'.';
    const data=await api(`/api/list?session_id=${encodeURIComponent(sessionId)}&path=${encodeURIComponent(path)}`);
    if(!S.session||S.session.session_id!==sessionId)return;
    S.entries=data.entries||[];renderBreadcrumb();renderFileTree();
    // #2673 — refresh Artifacts tab when its source data (the file tree) updates.
    if(typeof renderSessionArtifacts==='function') renderSessionArtifacts();
    // Pre-fetch contents of restored expanded dirs so they render without a second click
    // (parallelized — avoids serial waterfall when multiple dirs are expanded)
    if(dirPath==='.'){
      const expanded=S._expandedDirs||new Set();
      const pending=[...expanded].filter(dirPath=>!S._dirCache[dirPath]);
      if(pending.length){
        const results=await Promise.all(pending.map(dirPath=>
          api(`/api/list?session_id=${encodeURIComponent(sessionId)}&path=${encodeURIComponent(dirPath)}`)
            .then(dc=>({dirPath,entries:dc.entries||[]}))
            .catch(()=>({dirPath,entries:[]}))
        ));
        if(!S.session||S.session.session_id!==sessionId)return;
        for(const {dirPath,entries} of results) S._dirCache[dirPath]=entries;
      }
      if(expanded.size>0)renderFileTree();
    }
    if(!preservePreview&&typeof clearPreview==='function'){
      if(typeof _previewDirty!=='undefined'&&_previewDirty){
        showConfirmDialog({title:t('unsaved_confirm'),message:'',confirmLabel:'Discard',danger:true,focusCancel:true}).then(ok=>{if(ok)clearPreview({keepPanelOpen:true});});
      }else{
        clearPreview({keepPanelOpen:true});
      }
    }else if(preservePreview){
      await refreshOpenPreviewIfMutated();
    }
    // Fetch git status for workspace root (non-blocking)
    if(dirPath==='.') refreshGitStatus();
  }catch(e){console.warn('loadDir',e);}
}

async function _refreshGitBadge(){
  const badge=$('gitBadge');
  if(!badge||!S.session)return;
  const sessionId=S.session.session_id;
  try{
    const data=await api(`/api/git-info?session_id=${encodeURIComponent(sessionId)}`);
    if(!S.session||S.session.session_id!==sessionId)return;
    if(data.git&&data.git.is_git){
      const g=data.git;
      let text=g.branch||'git';
      if(g.dirty>0) text+=` \u00b7 ${g.dirty}\u2206`; // middot + delta
      if(g.behind>0) text+=` \u2193${g.behind}`;
      if(g.ahead>0) text+=` \u2191${g.ahead}`;
      badge.textContent=text;
      badge.className='git-badge'+(g.dirty>0?' dirty':'');
      badge.style.display='';
    } else {
      badge.style.display='none';
      badge.textContent='';
    }
  }catch(e){
    if(!S.session||S.session.session_id!==sessionId)return;
    badge.style.display='none';
  }
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
const MD_PREVIEW_RICH_RENDER_MAX_BYTES = 256 * 1024;
const MD_PREVIEW_RICH_RENDER_MAX_LINES = 5000;
// Binary formats that should download rather than preview
const DOWNLOAD_EXTS = new Set([
  '.docx','.doc','.xlsx','.xls','.pptx','.ppt','.odt','.ods','.odp',
  '.zip','.tar','.gz','.bz2','.7z','.rar',
  '.exe','.dmg','.pkg','.deb','.rpm',
  '.woff','.woff2','.ttf','.otf','.eot',
  '.bin','.dat','.db','.sqlite','.pyc','.class','.so','.dylib','.dll',
]);

function fileExt(p){ const i=p.lastIndexOf('.'); return i>=0?p.slice(i).toLowerCase():''; }

function markdownPreviewByteLength(content){
  const text=String(content||'');
  if(typeof Blob==='function') return new Blob([text]).size;
  if(typeof TextEncoder==='function') return new TextEncoder().encode(text).length;
  return unescape(encodeURIComponent(text)).length;
}

function markdownPreviewLineCount(content){
  const text=String(content||'');
  if(!text) return 1;
  return text.split('\n').length;
}

function shouldRenderMarkdownPreviewAsPlainText(content){
  return markdownPreviewByteLength(content)>MD_PREVIEW_RICH_RENDER_MAX_BYTES
    || markdownPreviewLineCount(content)>MD_PREVIEW_RICH_RENDER_MAX_LINES;
}

function largeMarkdownPlainTextStatus(content){
  const bytes=markdownPreviewByteLength(content);
  const lines=markdownPreviewLineCount(content);
  const sizeLabel=bytes>=1024?`${Math.round(bytes/1024)} KB`:`${bytes} B`;
  return `Large markdown file (${sizeLabel}, ${lines} lines) shown as plain text. Click "Render as markdown anyway" to force rich rendering, or Edit to view raw.`;
}

function setLargeMarkdownForceRenderVisible(visible){
  const btn=$('btnRenderMarkdownAnyway');
  if(btn) btn.style.display=visible?'inline-flex':'none';
}

function renderMarkdownPreviewContent(data){
  showPreview('md');
  $('previewMd').innerHTML=renderMd(data.content);
  requestAnimationFrame(()=>{if(typeof renderKatexBlocks==='function')renderKatexBlocks();});
}

function forceRenderMarkdownPreview(){
  // #3378 review (Codex): don't force-render from a dirty/open editor — the
  // cached raw content would not reflect the unsaved edit. Require a saved,
  // non-dirty state and cached content that belongs to the current file.
  if(_previewDirty || $('previewEditArea').style.display!=='none') return;
  if(!_previewRawContent || _previewRawContentPath!==_previewCurrentPath) return;
  openFile(_previewCurrentPath,{forceRichMarkdown:true});
  setStatus('Markdown rendered for this file.');
}

let _previewCurrentPath = '';  // relative path of currently previewed file
let _previewCurrentMode = '';  // 'code' | 'md' | 'image' | 'html' | 'pdf' | 'audio' | 'video'
let _previewDirty = false;     // true when edits are unsaved
let _previewReturnTarget = 'files'; // 'files' | 'changes'
let _editorSoftWrap = false;

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
  const editorShell=$('workspaceEditorShell'); if(editorShell) editorShell.style.display = mode==='code' ? 'flex' : 'none';
  const readShell=$('previewReadShell'); if(readShell) readShell.style.display = mode==='code' ? 'grid' : 'none';
  const editShell=$('previewEditShell'); if(editShell) editShell.style.display = 'none';
  $('previewImgWrap').style.display  = mode==='image' ? '' : 'none';
  const mediaWrap=$('previewMediaWrap'); if(mediaWrap) mediaWrap.style.display = (mode==='audio'||mode==='video') ? '' : 'none';
  const pdfWrap=$('previewPdfWrap'); if(pdfWrap) pdfWrap.style.display = mode==='pdf' ? '' : 'none';
  $('previewMd').style.display       = mode==='md'    ? '' : 'none';
  $('previewHtmlWrap').style.display = mode==='html'  ? '' : 'none';
  const diffView=$('gitDiffView'); if(diffView) diffView.style.display = mode==='gitdiff' ? 'flex' : 'none';
  const editArea=$('previewEditArea'); if(editArea) editArea.onkeydown=null;  // start in read-only
  const badge=$('previewBadge');
  badge.className='preview-badge '+mode;
  badge.textContent = mode==='image'?'image':mode==='audio'?'audio':mode==='video'?'video':mode==='pdf'?'pdf':mode==='md'?'md':mode==='html'?'html':mode==='gitdiff'?'diff':fileExt($('previewPathText').textContent)||'text';
  _previewCurrentMode = mode;
  _previewDirty = false;
  refreshEditorChrome();
  updateEditBtn();
  // Show "Open in browser" button for iframe-backed document previews
  const openBtn=$('btnOpenInBrowser');
  if(openBtn) openBtn.style.display = (mode==='html'||mode==='pdf')?'inline-flex':'none';
  setLargeMarkdownForceRenderVisible(false);
}

function updateEditBtn(){
  const btn=$('btnEditFile');
  if(!btn)return;
  const editable = _previewCurrentMode==='code'||_previewCurrentMode==='md';
  const editing = _isPreviewEditing();
  btn.style.display = editable&&!editing?'':'none';
  btn.innerHTML = `&#9998; ${t('edit')}`;
  btn.title = t('edit_title');
  btn.style.color = '';
}

async function toggleEditMode(){
  const editing = _isPreviewEditing();
  if(editing){
    // Save
    if(!S.session||!_previewCurrentPath)return;
    const content=$('previewEditArea').value;
    try{
      await api('/api/file/save',{method:'POST',body:JSON.stringify({
        session_id:S.session.session_id, path:_previewCurrentPath, content
      })});
      _previewDirty=false;
      // Update read-only views AND the cached raw content so a later
      // "Render as markdown anyway" force-render reflects the just-saved text
      // (not the stale pre-edit fetch). #3378 review (Codex).
      _previewRawContent = content;
      _previewRawContentPath = _previewCurrentPath;
      if(_previewCurrentMode==='code') $('previewCode').textContent=content;
      else renderMarkdownPreviewContent({content});
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
    _initEditorPrefs();
    const editorShell=$('workspaceEditorShell'); if(editorShell)editorShell.style.display='flex';
    $('previewEditArea').value=currentText;
    const editShell=$('previewEditShell'); if(editShell)editShell.style.display='grid';
    const readShell=$('previewReadShell'); if(readShell&&_previewCurrentMode==='code')readShell.style.display='none';
    else $('previewMd').style.display='none';
    $('previewEditArea').onkeydown=handleEditorKeydown;
    $('previewEditArea').onkeyup=refreshEditorChrome;
    $('previewEditArea').onclick=refreshEditorChrome;
    $('previewEditArea').focus();
  }
  refreshEditorChrome();
  updateEditBtn();
}

let _previewRawContent = '';  // raw text for md files (to populate editor)
let _previewRawContentPath = '';  // path that _previewRawContent belongs to (#3378 force-render cache guard)

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
  const editShell=$('previewEditShell'); if(editShell)editShell.style.display='none';
  $('previewEditArea').onkeydown=null;
  if(_previewCurrentMode==='code'){const readShell=$('previewReadShell');if(readShell)readShell.style.display='grid';}
  else {const editorShell=$('workspaceEditorShell');if(editorShell)editorShell.style.display='none';$('previewMd').style.display='';}
  _previewDirty=false;
  refreshEditorChrome();
  updateEditBtn();
}

// Map file extensions to Prism.js language identifiers.
// Prism autoloader fetches missing language components from CDN on demand.
const _PRISM_LANG_MAP={
  js:'javascript',mjs:'javascript',jsx:'jsx',ts:'typescript',tsx:'tsx',
  py:'python',pyw:'python',pyi:'python',
  rb:'ruby',go:'go',rs:'rust',java:'java',kt:'kotlin',kts:'kotlin',
  c:'c',h:'c',cpp:'cpp',cxx:'cpp',hpp:'cpp',cc:'cpp',
  cs:'csharp',swift:'swift',scala:'scala',
  php:'php',pl:'perl',pm:'perl',r:'r',lua:'lua',
  sh:'bash',bash:'bash',zsh:'bash',fish:'bash',
  ps1:'powershell',psm1:'powershell',
  sql:'sql',graphql:'graphql',
  json:'json',yaml:'yaml',yml:'yaml',toml:'toml',xml:'xml',
  html:'markup',htm:'markup',svg:'markup',vue:'markup',
  css:'css',scss:'scss',sass:'sass',less:'less',
  md:'markdown',markdown:'markdown',
  dockerfile:'docker',makefile:'makefile',cmake:'cmake',
  ini:'ini',cfg:'ini',conf:'ini',properties:'properties',
  diff:'diff',patch:'diff',
  txt:'',log:'',csv:'',tsv:'',
};
const _PRISM_BASENAME_LANG_MAP={
  'dockerfile':'docker','makefile':'makefile','gnumakefile':'makefile',
  'cmakelists.txt':'cmake',
  '.gitignore':'ignore','.dockerignore':'ignore',
};
function _prismLanguageForPath(path){
  const base=String(path||'').split(/[\\/]/).pop().toLowerCase();
  if(base.startsWith('dockerfile.')) return 'docker';
  if(_PRISM_BASENAME_LANG_MAP[base]!==undefined) return _PRISM_BASENAME_LANG_MAP[base];
  const ext=fileExt(path).replace(/^\./,'');
  return _PRISM_LANG_MAP[ext]!==undefined?_PRISM_LANG_MAP[ext]:'plaintext';
}

async function openFile(path, opts={}){
  if(!S.session)return;
  const ext=fileExt(path);
  const bustCache=!!(opts&&opts.bustCache);
  const forceRichMarkdown=!!(opts&&opts.forceRichMarkdown);
  const cacheBust=bustCache?`&_=${Date.now()}`:'';

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
    const url=`api/file/raw?session_id=${encodeURIComponent(S.session.session_id)}&path=${encodeURIComponent(path)}${cacheBust}`;
    $('previewImg').alt=path;
    $('previewImg').src=url;
    $('previewImg').onerror=()=>setStatus(t('image_load_failed'));
  } else if(AUDIO_EXTS.has(ext)||VIDEO_EXTS.has(ext)){
    const mode=VIDEO_EXTS.has(ext)?'video':'audio';
    showPreview(mode);
    const url=`api/file/raw?session_id=${encodeURIComponent(S.session.session_id)}&path=${encodeURIComponent(path)}&inline=1${cacheBust}`;
    const wrap=$('previewMediaWrap');
    if(wrap){
      wrap.innerHTML=(typeof _mediaPlayerHtml==='function')
        ? _mediaPlayerHtml(mode,url,path.split('/').pop()||path)
        : `<${mode} src="${url.replace(/"/g,'%22')}" controls preload="metadata"></${mode}>`;
      if(typeof _applyMediaPlaybackPreferences==='function') _applyMediaPlaybackPreferences(wrap);
    }
  } else if(PDF_EXTS.has(ext)){
    showPreview('pdf');
    const url=`api/file/raw?session_id=${encodeURIComponent(S.session.session_id)}&path=${encodeURIComponent(path)}&inline=1${cacheBust}`;
    const frame=$('previewPdfFrame');
    if(frame){
      frame.src=''; // clear first to avoid stale content
      frame.src=url;
      frame.title=`PDF preview: ${path.split('/').pop()||path}`;
    }
  } else if(MD_EXTS.has(ext)){
    // Markdown: fetch text, render with renderMd, display as formatted HTML
    try{
      // #3378 review (Codex): only reuse cached raw content when it actually
      // belongs to the requested path. `path===_previewCurrentPath` is tautological
      // here (_previewCurrentPath was just assigned above), so guard on the
      // dedicated _previewRawContentPath instead — otherwise a force-render after a
      // file switch could re-render the previous file's cached content.
      const data=forceRichMarkdown&&path===_previewRawContentPath&&_previewRawContent
        ? {content:_previewRawContent}
        : await api(`/api/file?session_id=${encodeURIComponent(S.session.session_id)}&path=${encodeURIComponent(path)}`);
      _previewRawContent = data.content;
      _previewRawContentPath = path;
      if(!forceRichMarkdown && shouldRenderMarkdownPreviewAsPlainText(data.content)){
        showPreview('code');
        $('previewCode').textContent=data.content;
        setLargeMarkdownForceRenderVisible(true);
        setStatus(largeMarkdownPlainTextStatus(data.content));
        return;
      }
      renderMarkdownPreviewContent(data);
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
    const url=`api/file/raw?session_id=${encodeURIComponent(S.session.session_id)}&path=${encodeURIComponent(path)}&inline=1${cacheBust}`;
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
      // Syntax highlighting with Prism.js (already loaded on the page).
      const codeEl=document.createElement('code');
      codeEl.textContent=data.content;
      const lang=_prismLanguageForPath(path);
      if(lang) codeEl.className='language-'+lang;
      const pre=$('previewCode');
      pre.textContent='';
      // Prism.highlightElement() propagates the language-* class onto the
      // parent <pre>, so a previously-previewed code file leaves e.g.
      // "language-css" on #previewCode. A subsequent plain-text file builds a
      // class-less <code>, and Prism walks up to that stale ancestor class and
      // mis-highlights prose. Strip any inherited language-* token from the
      // <pre> before each render so highlighting never leaks across files.
      pre.className=pre.className.replace(/\blanguage-\S+/g,'').replace(/\s+/g,' ').trim();
      pre.appendChild(codeEl);
      // Only invoke Prism when we actually assigned a language; otherwise the
      // class-less <code> would inherit any ancestor language-* class.
      if(lang&&typeof Prism!=='undefined'&&typeof Prism.highlightElement==='function'){
        Prism.highlightElement(codeEl);
      }
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
  const url=`api/file/raw?session_id=${encodeURIComponent(S.session.session_id)}&path=${encodeURIComponent(_previewCurrentPath)}&inline=1`;
  window.open(url,'_blank','noopener');
}

// ── Workspace upload ──────────────────────────────────────────────────
function triggerWorkspaceUpload() {
  const input = $('workspaceFileInput');
  if (!input) return;
  input.value = '';
  input.onchange = async () => {
    const files = input.files;
    if (!files || !files.length) return;
    for (const file of files) {
      await uploadToWorkspace(file, S.currentDir || '.');
    }
    if (S.session) loadDir(S.currentDir);
  };
  input.click();
}

async function uploadToWorkspace(file, dir) {
  if (!S.session) return;
  const formData = new FormData();
  formData.append('session_id', S.session.session_id);
  formData.append('path', dir || '.');
  formData.append('file', file, file.name);
  try {
    showToast(t('uploading') || 'Uploading\u2026', 2000);
    const data = await api('/api/workspace/upload', {
      method: 'POST',
      body: formData,
      headers: {},
      timeoutMs: 120000,
    });
    if (data && data.error) {
      showToast(data.error, 5000, 'error');
    } else if (data && (data.extract_error || (Array.isArray(data.files) && data.files.some(function(f){return f && f.extract_error;})))) {
      // Archive was rejected (zip-slip / zip-bomb / corrupt / too-many-members):
      // the file uploaded but extraction failed. Surface it as an error instead
      // of a misleading "Uploaded" success toast.
      var msg = data.extract_error
        || (data.files.find(function(f){return f && f.extract_error;}) || {}).extract_error
        || 'Archive extraction failed';
      showToast(msg, 5000, 'error');
    } else {
      showToast(t('uploaded') || ('Uploaded ' + (data.filename || file.name)), 2000);
    }
  } catch (e) {
    showToast(t('upload_failed') || ('Upload failed: ' + e.message), 5000, 'error');
  }
}

function _isOsFilesDrag(e) {
  return !!(e.dataTransfer && e.dataTransfer.types && e.dataTransfer.types.includes('Files'));
}

function _joinWorkspacePath(base, rel) {
  const b = base || '.';
  const r = (rel || '').replace(/^\/+|\/+$/g, '');
  if (!r) return b;
  return b === '.' ? r : `${b}/${r}`;
}

function _targetDirForRelDir(destDir, relDir) {
  const dirPart = (relDir || '').replace(/\/+$/, '');
  if (!dirPart) return destDir || '.';
  return _joinWorkspacePath(destDir, dirPart);
}

async function _readAllDirectoryEntries(reader) {
  const entries = [];
  while (true) {
    const batch = await new Promise((resolve, reject) => {
      reader.readEntries(resolve, reject);
    });
    if (!batch.length) break;
    entries.push(...batch);
  }
  return entries;
}

async function _collectFilesFromEntry(entry, relPrefix) {
  if (entry.isFile) {
    const file = await new Promise((resolve, reject) => {
      entry.file(resolve, reject);
    });
    return [{ file, relDir: relPrefix || '' }];
  }
  if (!entry.isDirectory) return [];
  const reader = entry.createReader();
  const children = await _readAllDirectoryEntries(reader);
  const dirPrefix = `${relPrefix || ''}${entry.name}/`;
  let out = [];
  for (const child of children) {
    out = out.concat(await _collectFilesFromEntry(child, dirPrefix));
  }
  return out;
}

async function _collectOsDropUploads(dataTransfer) {
  const out = [];
  const items = dataTransfer.items ? [...dataTransfer.items] : [];
  if (items.length && typeof items[0].webkitGetAsEntry === 'function') {
    for (const item of items) {
      if (item.kind !== 'file') continue;
      const entry = item.webkitGetAsEntry();
      if (!entry) continue;
      out.push(...await _collectFilesFromEntry(entry, ''));
    }
    if (out.length) return out;
  }
  for (const file of dataTransfer.files) {
    out.push({ file, relDir: '' });
  }
  return out;
}

async function uploadOsDropToWorkspace(dataTransfer, destDir) {
  if (!S.session || !dataTransfer) return;
  const uploads = await _collectOsDropUploads(dataTransfer);
  for (const { file, relDir } of uploads) {
    await uploadToWorkspace(file, _targetDirForRelDir(destDir, relDir));
  }
  if (S.session) await loadDir(S.currentDir);
}

function _clearWorkspaceOsUploadDragOver() {
  document.querySelectorAll('.file-item.drag-over-upload,.breadcrumb-seg.drag-over-upload').forEach((el) => {
    el.classList.remove('drag-over-upload');
  });
}

function _bindWorkspaceOsUploadDropTarget(el, destDir) {
  // Use addEventListener (not on-property assignment) so these OS-upload
  // handlers COMPOSE with the workspace tree-MOVE handlers bound by
  // _bindWorkspaceMoveDropTarget() on the same element. A property assignment
  // for the drop handler here would overwrite the move handler, and a
  // workspace-file drag would fall through to the document drop (inserting
  // @path into the composer) instead of moving the file. Each handler gates on
  // its own drag type (_isOsFilesDrag vs _isWorkspaceTreeMoveDrag), so only the
  // matching one acts.
  el.addEventListener('dragenter', (e) => {
    if (!_isOsFilesDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();
    el.classList.add('drag-over-upload');
  });
  el.addEventListener('dragover', (e) => {
    if (!_isOsFilesDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
    el.classList.add('drag-over-upload');
  });
  el.addEventListener('dragleave', (e) => {
    if (el.contains(e.relatedTarget)) return;
    el.classList.remove('drag-over-upload');
  });
  el.addEventListener('drop', async (e) => {
    if (!_isOsFilesDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();
    el.classList.remove('drag-over-upload');
    await uploadOsDropToWorkspace(e.dataTransfer, destDir);
  });
}

// Drag-and-drop files onto workspace file tree
if (typeof document !== 'undefined') {
  const _wsUploadInit = () => {
    const tree = $('fileTree');
    if (!tree) return;
    tree.addEventListener('dragenter', (e) => {
      if (e.dataTransfer && e.dataTransfer.types && e.dataTransfer.types.includes('Files')) {
        e.preventDefault();
        e.stopPropagation();
      }
    });
    tree.addEventListener('dragover', (e) => {
      if (e.dataTransfer && e.dataTransfer.types && e.dataTransfer.types.includes('Files')) {
        e.preventDefault();
        e.stopPropagation();
        if (e.target.closest('.file-item[data-ws-type="dir"],.breadcrumb-seg')) return;
        e.dataTransfer.dropEffect = 'copy';
        tree.classList.add('drag-over-upload');
      }
    });
    tree.addEventListener('dragleave', (e) => {
      if (tree.contains(e.relatedTarget)) return;
      tree.classList.remove('drag-over-upload');
    });
    tree.addEventListener('drop', async (e) => {
      tree.classList.remove('drag-over-upload');
      if (!e.dataTransfer || !e.dataTransfer.types || !e.dataTransfer.types.includes('Files')) return;
      if (e.target.closest('.file-item[data-ws-type="dir"],.breadcrumb-seg')) return;
      e.preventDefault();
      e.stopPropagation();
      await uploadOsDropToWorkspace(e.dataTransfer, S.currentDir || '.');
    });
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _wsUploadInit, {once: true});
  } else {
    _wsUploadInit();
  }
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
  view.className='git-diff-view '+_currentGitDiffMode();
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
  const toolbar=document.createElement('div');
  toolbar.className='git-diff-toolbar';
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
  const copy=document.createElement('button');
  copy.className='mini-btn';
  copy.textContent=t('copy_file_path')||'Copy path';
  copy.onclick=async()=>{try{await navigator.clipboard.writeText(diff.path);showToast(t('path_copied')||'Copied');}catch(e){showToast(t('path_copy_failed')||'Copy failed',2600,'error');}};
  actions.appendChild(copy);
  const modes=document.createElement('div');
  modes.className='git-diff-mode-controls';
  for(const mode of ['unified','split']){
    const btn=document.createElement('button');
    btn.className='mini-btn git-diff-mode-btn'+(_currentGitDiffMode()===mode?' active':'');
    btn.type='button';
    btn.textContent=mode==='split'?(t('git_diff_split')||'Split'):(t('git_diff_unified')||'Unified');
    btn.onclick=()=>setGitDiffMode(mode);
    modes.appendChild(btn);
  }
  toolbar.append(actions,modes);
  view.appendChild(toolbar);
  const parsed=parseUnifiedDiff(text,diff.path);
  renderParsedGitDiff(view,parsed,_currentGitDiffMode());
}

function _parseHunkHeader(line){
  const m=line.match(/^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?/);
  if(!m)return null;
  return {oldStart:parseInt(m[1],10),oldCount:parseInt(m[2]||'1',10),newStart:parseInt(m[3],10),newCount:parseInt(m[4]||'1',10)};
}

function parseUnifiedDiff(text,path){
  const file={oldPath:path,newPath:path,hunks:[],meta:[]};
  let hunk=null,oldLine=0,newLine=0;
  for(const raw of String(text||'').split('\n')){
    if(raw.startsWith('--- ')){file.oldPath=raw.slice(4).replace(/^a\//,'');file.meta.push(raw);continue;}
    if(raw.startsWith('+++ ')){file.newPath=raw.slice(4).replace(/^b\//,'');file.meta.push(raw);continue;}
    if(raw.startsWith('diff --git')||raw.startsWith('index ')||raw.startsWith('new file mode')||raw.startsWith('deleted file mode')||raw.startsWith('rename ')){file.meta.push(raw);continue;}
    if(raw.startsWith('@@')){
      const parsed=_parseHunkHeader(raw);
      oldLine=parsed?parsed.oldStart:0;
      newLine=parsed?parsed.newStart:0;
      hunk={header:raw,oldStart:oldLine,newStart:newLine,lines:[]};
      file.hunks.push(hunk);
      continue;
    }
    if(!hunk)continue;
    const sign=raw[0]||' ';
    const content=raw.length?raw.slice(1):'';
    if(sign==='+'){
      hunk.lines.push({type:'add',oldLine:null,newLine:newLine++,text:content});
    }else if(sign==='-'){
      hunk.lines.push({type:'del',oldLine:oldLine++,newLine:null,text:content});
    }else if(sign==='\\'){
      hunk.lines.push({type:'meta',oldLine:null,newLine:null,text:raw});
    }else{
      hunk.lines.push({type:'ctx',oldLine:oldLine++,newLine:newLine++,text:raw.startsWith(' ')?content:raw});
    }
  }
  return file;
}

function _diffCell(text,cls=''){
  const el=document.createElement('span');
  el.className=cls;
  el.textContent=text==null?'':String(text);
  return el;
}

function renderParsedGitDiff(view,file,mode){
  const wrap=document.createElement('div');
  wrap.className='git-diff-file';
  const header=document.createElement('div');
  header.className='git-diff-file-header';
  header.append(_diffCell('old','git-diff-ln'),_diffCell('new','git-diff-ln'),_diffCell(`${file.oldPath} → ${file.newPath}`,'git-diff-code'));
  wrap.appendChild(header);
  for(const hunk of file.hunks){
    const h=document.createElement('div');
    h.className='git-diff-hunk';
    h.append(_diffCell('', 'git-diff-ln'),_diffCell('', 'git-diff-ln'),_diffCell(hunk.header,'git-diff-code'));
    wrap.appendChild(h);
    const rows=mode==='split'?_splitDiffRows(hunk.lines):hunk.lines;
    for(const rowData of rows){
      wrap.appendChild(mode==='split'?_renderSplitDiffRow(rowData):_renderUnifiedDiffRow(rowData));
    }
  }
  view.appendChild(wrap);
}

function _renderUnifiedDiffRow(line){
  const row=document.createElement('div');
  row.className=`git-diff-row ${line.type}`;
  const prefix=line.type==='add'?'+':line.type==='del'?'-':' ';
  row.append(_diffCell(line.oldLine||'', 'git-diff-ln'),_diffCell(line.newLine||'', 'git-diff-ln'),_diffCell(prefix+line.text,'git-diff-code'));
  return row;
}

function _splitDiffRows(lines){
  const rows=[];
  for(let i=0;i<lines.length;i++){
    const line=lines[i];
    if(line.type==='del'&&lines[i+1]&&lines[i+1].type==='add'){
      rows.push({type:'change',old:line,new:lines[i+1]});
      i++;
    }else if(line.type==='del')rows.push({type:'del',old:line,new:null});
    else if(line.type==='add')rows.push({type:'add',old:null,new:line});
    else rows.push({type:line.type,old:line,new:line});
  }
  return rows;
}

function _renderSplitDiffRow(pair){
  const row=document.createElement('div');
  row.className=`git-diff-split-row ${pair.type}`;
  const oldLine=pair.old, newLine=pair.new;
  row.append(
    _diffCell(oldLine&&oldLine.oldLine||'', 'git-diff-ln'),
    _diffCell(oldLine?((oldLine.type==='del'?'-':' ')+oldLine.text):'', 'git-diff-code old-code'),
    _diffCell(newLine&&newLine.newLine||'', 'git-diff-ln'),
    _diffCell(newLine?((newLine.type==='add'?'+':' ')+newLine.text):'', 'git-diff-code new-code')
  );
  return row;
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

async function stageGitSelectedChanges(){
  if(!S.session)return;
  const paths=_gitSelectedFiles().filter(f=>!f.conflict&&(f.unstaged||f.untracked)).map(f=>f.path);
  if(!paths.length){showToast(t('git_select_files')||'Select files',2200);return;}
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

async function discardGitSelectedChanges(){
  if(!S.session)return;
  const selected=_gitSelectedFiles().filter(f=>!f.conflict&&(f.unstaged||f.untracked));
  const paths=selected.map(f=>f.path);
  if(!paths.length){showToast(t('git_select_files')||'Select files',2200);return;}
  const hasUntracked=selected.some(f=>f.untracked);
  const ok=await showConfirmDialog({
    title:t('git_discard_selected_confirm_title'),
    message:t('git_discard_selected_confirm_message',paths.length),
    confirmLabel:hasUntracked?t('git_discard_delete_selected'):t('git_discard_selected'),
    danger:true,
    focusCancel:true
  });
  if(!ok)return;
  const git=_ensureGitState();
  git.mutating=true;renderGitChanges();
  try{
    const data=await api('/api/git/discard',{method:'POST',body:JSON.stringify({session_id:S.session.session_id,paths,delete_untracked:hasUntracked})});
    _setGitStatus(data.git);
    if(S.git.selectedDiff&&paths.includes(S.git.selectedDiff.path)){
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

function _gitRemoteActionLabel(action){
  return action==='fetch'?t('git_fetched'):action==='pull'?t('git_pulled'):t('git_pushed');
}

function _gitRemoteToastMessage(action,data){
  const label=_gitRemoteActionLabel(action);
  const raw=String(data&&data.message?data.message:'').trim();
  if(!raw)return label;
  const lines=raw.split(/\r?\n/).map(line=>line.trim()).filter(Boolean);
  const refs=[];
  let remote='';
  const fallback=[];
  lines.forEach(line=>{
    if(line.startsWith('From ')){
      remote=line.slice(5).trim().replace(/^https?:\/\//,'').replace(/\.git$/,'');
      return;
    }
    const compact=line.replace(/\s+/g,' ');
    const refLine=compact.replace(/^[*+=!-]\s+/,'').replace(/^\[[^\]]+\]\s+/,'');
    const match=refLine.match(/^(?:(\S+\.\.\S+)\s+)?(\S+)\s+->\s+(\S+)(?:\s+\(.+\))?$/);
    if(match){
      const range=match[1];
      const src=match[2];
      const dst=match[3];
      refs.push(`${src} -> ${dst}${range?` (${range})`:''}`);
    }else{
      fallback.push(compact);
    }
  });
  if(refs.length){
    const shown=refs.slice(0,3);
    if(refs.length>shown.length)shown.push(`+${refs.length-shown.length} more refs`);
    return [label, remote?`Remote ${remote}`:null, ...shown].filter(Boolean).join('\n');
  }
  return [label, ...fallback.slice(0,3)].filter(Boolean).join('\n');
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
    showToast(_gitRemoteToastMessage(action,data),4200);
    await loadDir(S.currentDir);
  }catch(e){
    showToast(`${t('git_sync_failed')}: ${e.message}`,4000,'error');
  }finally{
    git.syncing=null;
    git.mutating=false;
    renderGitChanges();
  }
}

function _installWorkspaceInteractionGuards(){
  if(window.__hermesWorkspaceInteractionGuardsInstalled)return;
  window.__hermesWorkspaceInteractionGuardsInstalled=true;
  document.addEventListener('click',event=>{
    const git=_ensureGitState();
    if(!git.branchMenuOpen)return;
    const control=$('gitBranchControl');
    if(control&&control.contains(event.target))return;
    closeGitBranchMenu();
  });
  document.addEventListener('keydown',event=>{
    if(event.key!=='Escape')return;
    const git=_ensureGitState();
    if(!git.branchMenuOpen)return;
    event.preventDefault();
    closeGitBranchMenu();
    const btn=$('btnGitBranchMenu');
    if(btn)btn.focus();
  });
}

_installWorkspaceInteractionGuards();

async function _autoRefreshWorkspaceGitStatus(){
  if(!S.session)return;
  if(!_workspacePanelOpenForAutoRefresh())return;
  const git=_ensureGitState();
  if(git.mutating||git.syncing||git.generatingCommitMessage||git.branchMenuOpen)return;
  if(typeof _previewDirty!=='undefined'&&_previewDirty)return;
  await refreshGitStatus({auto:true,refreshBranches:false});
}

function _shouldAutoFetchWorkspaceGit(){
  if(!S.session)return false;
  if(!_workspacePanelOpenForAutoRefresh())return false;
  const git=_ensureGitState();
  if(!git.status||!git.status.is_git)return false;
  if(git.mutating||git.syncing||git.autoFetching||git.generatingCommitMessage||git.branchMenuOpen)return false;
  if(typeof _previewDirty!=='undefined'&&_previewDirty)return false;
  const now=Date.now();
  if(git.lastAutoFetchAt&&now-git.lastAutoFetchAt<GIT_AUTO_FETCH_MS)return false;
  if(git.lastAutoFetchErrorAt&&now-git.lastAutoFetchErrorAt<GIT_AUTO_FETCH_MIN_ERROR_BACKOFF_MS)return false;
  return true;
}

async function _autoFetchWorkspaceGit(){
  if(!_shouldAutoFetchWorkspaceGit())return null;
  const git=_ensureGitState();
  git.autoFetching=true;
  _renderGitAutoFetchStatus();
  try{
    const priorSignature=_gitStatusSignature(git.status);
    const data=await api(`/api/git/fetch`,{method:'POST',body:JSON.stringify({session_id:S.session.session_id})});
    git.lastAutoFetchAt=Date.now();
    git.lastAutoFetchErrorAt=0;
    git.lastAutoFetchError='';
    git.autoFetchFailureCount=0;
    _setGitStatus(data.status);
    const changed=priorSignature!==_gitStatusSignature(git.status);
    if(changed&&(git.branchMenuOpen||git.branches))refreshGitBranches();
    return data;
  }catch(e){
    git.lastAutoFetchErrorAt=Date.now();
    git.lastAutoFetchError=e&&e.message?e.message:String(e||'Auto-fetch failed');
    git.autoFetchFailureCount=(git.autoFetchFailureCount||0)+1;
    if(git.autoFetchFailureCount>=3&&typeof showToast==='function'){
      showToast(`Git auto-fetch failed: ${git.lastAutoFetchError}`,4000,'warning');
    }
    _renderGitAutoFetchStatus();
    return null;
  }finally{
    git.autoFetching=false;
    _renderGitAutoFetchStatus();
  }
}

function _visibleWorkspaceDirsForRefresh(){
  const dirs=[];
  const add=dir=>{
    dir=_normalizeWorkspaceDirPath(dir);
    if(!dirs.includes(dir))dirs.push(dir);
  };
  add(S.currentDir||'.');
  for(const dir of [...(S._expandedDirs||new Set())]){
    add(dir);
    if(dirs.length>=WORKSPACE_TREE_AUTO_REFRESH_MAX_DIRS)break;
  }
  return dirs.slice(0,WORKSPACE_TREE_AUTO_REFRESH_MAX_DIRS);
}

function _shouldRefreshWorkspaceTree(){
  if(!S.session)return false;
  if(!_workspacePanelOpenForAutoRefresh())return false;
  if(typeof _previewDirty!=='undefined'&&_previewDirty)return false;
  if(S._treeRefreshing)return false;
  const git=_ensureGitState();
  if(git.mutating||git.syncing)return false;
  return true;
}

async function _refreshWorkspaceTreeIfChanged(){
  if(!_shouldRefreshWorkspaceTree())return;
  S._treeRefreshing=true;
  try{
    const signatures=_ensureWorkspaceDirMetadata();
    const dirs=_visibleWorkspaceDirsForRefresh();
    let changed=false;
    for(const dir of dirs){
      let data;
      try{data=await _fetchWorkspaceDir(dir);}catch(e){continue;}
      const nextSignature=typeof data?.signature==='string'?data.signature:null;
      if(nextSignature&&signatures[dir]&&signatures[dir]===nextSignature)continue;
      _storeWorkspaceDirListing(dir,data);
      changed=true;
    }
    if(changed){
      const scrollEl=$('fileTree');
      const scrollTop=scrollEl?scrollEl.scrollTop:0;
      renderBreadcrumb();
      renderFileTree();
      renderWorkspacePanelTabState();
      if(scrollEl)scrollEl.scrollTop=scrollTop;
    }
  }finally{
    S._treeRefreshing=false;
  }
}

function _installWorkspaceGitAutoRefresh(){
  if(window.__hermesWorkspaceGitAutoRefreshInstalled)return;
  window.__hermesWorkspaceGitAutoRefreshInstalled=true;
  window.setInterval(()=>{_autoRefreshWorkspaceGitStatus();},GIT_AUTO_REFRESH_MS);
  window.setInterval(()=>{_refreshWorkspaceTreeIfChanged();},WORKSPACE_TREE_AUTO_REFRESH_MS);
  window.setInterval(()=>{_autoFetchWorkspaceGit();},GIT_AUTO_FETCH_MS);
  document.addEventListener('visibilitychange',()=>{
    if(document.visibilityState==='visible'){
      _autoRefreshWorkspaceGitStatus();
      _refreshWorkspaceTreeIfChanged();
      _autoFetchWorkspaceGit();
    }
  });
}

_installWorkspaceGitAutoRefresh();
