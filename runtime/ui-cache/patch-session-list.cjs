'use strict';

// Injected into the published browser module, with one instance per SessionManager.
// The durable cache contains presentation hints only. Projection sequence numbers,
// list membership, blank status and access are always established by the SDK.
class SidebarTitles {
  scope = null;
  generation = null;
  checked = false;
  excludedDuringRead = null;
  listed = new Map();
  listedGeneration = null;
  rows = new Map();
  writes = Promise.resolve();
  dirty = false;
  unsaved = false;

  async connect(generation, changed) {
    const access = globalThis.__HOMEAI_CHAT_CACHE_ACCESS__;
    this.generation = generation;
    this.checked = false;
    const excluded = this.excludedDuringRead = new Set();
    let scope = null;
    try { scope = await access?.scope(generation); } catch {}
    if (this.generation !== generation) return;
    if (typeof scope !== 'string' || !/^[a-f0-9]{32}$/.test(scope)) scope = null;
    if (scope !== this.scope) {
      this.scope = null;
      if (this.listedGeneration !== generation) this.listed.clear();
      this.rows.clear();
      this.unsaved = false;
      this.checked = true;
      changed();
      if (scope !== null) {
        let record;
        try { record = await access.read(scope, 'titles'); } catch {}
        if (this.generation !== generation) return;
        const now = Date.now();
        if (Array.isArray(record?.rows) && record.rows.length <= 128 &&
            Number.isSafeInteger(record.savedAt) && record.savedAt <= now && now - record.savedAt < 24 * 3600000) {
          for (const pair of record.rows) {
            if (!Array.isArray(pair) || pair.length !== 2 || !this.valid(pair[0], pair[1])) continue;
            if (excluded.has(pair[0])) this.unsaved = true;
            else this.rows.set(...pair);
          }
        }
      }
      this.scope = scope;
    }
    this.excludedDuringRead = null;
    this.checked = true;
    if (this.listedGeneration === generation) this.prune();
    if (this.unsaved) this.save();
    changed();
  }

  valid(id, title) {
    return typeof id === 'string' && id.length > 0 && id.length <= 256 &&
      typeof title === 'string' && title.length > 0 && title.length <= 256;
  }

  reconcile(summaries) {
    this.listedGeneration = this.generation;
    this.listed = new Map(summaries.map(row => [row.sessionId, row.updatedAt]));
    if (this.checked) this.prune();
  }

  prune() {
    for (const id of this.rows.keys()) if (!this.listed.has(id)) this.forget(id);
  }

  forget(id) {
    this.excludedDuringRead?.add(id);
    if (this.rows.delete(id)) this.save();
  }

  admits(id) {
    if (this.rows.has(id) || this.rows.size < 128) return true;
    let oldest;
    for (const candidate of this.rows.keys()) {
      if (oldest === undefined || this.listed.get(candidate) < this.listed.get(oldest)) oldest = candidate;
    }
    if (this.listed.get(id) <= this.listed.get(oldest)) return false;
    this.rows.delete(oldest);
    return true;
  }

  display(id, raw, blank, authoritative, previous) {
    if (blank || authoritative && raw == null) {
      this.forget(id);
      return raw;
    }
    if (!this.checked) return this.scope && this.listed.has(id) && raw == null ? previous : raw;
    if (!this.scope || !this.listed.has(id)) return raw;
    if (typeof raw === 'string') {
      if (!this.valid(id, raw)) this.forget(id);
      else if (this.rows.get(id) !== raw && this.admits(id)) {
        this.rows.set(id, raw);
        this.save();
      }
      return raw;
    }
    return this.rows.get(id);
  }

  save() {
    this.unsaved = true;
    if (this.dirty || !this.scope || !this.checked) return;
    this.dirty = true;
    const scope = this.scope;
    this.writes = this.writes.then(async () => {
      this.dirty = false;
      if (this.scope !== scope || !this.checked) { this.save(); return; }
      this.unsaved = false;
      const generation = this.generation;
      const access = globalThis.__HOMEAI_CHAT_CACHE_ACCESS__;
      const rows = [...this.rows].slice(0, 128);
      if (rows.length) await access.write(scope, 'titles', {savedAt: Date.now(), rows});
      else await access.clear(scope, 'titles');
      if (this.generation !== generation && this.scope === scope) this.save();
    }).catch(() => {});
  }
}

// Each anchor names exactly one instruction in the pinned 0.2.2-rc.2 module.
// The installer also checks the package version and digest before applying this.
function transform(source) {
  function replace(before, after) {
    if (source.indexOf(before) === -1 || source.indexOf(before) !== source.lastIndexOf(before)) {
      throw new Error('Unexpected session-controller client at ' + before.slice(0, 75));
    }
    source = source.replace(before, () => after);
  }
  // Paint the recent tail on first open. Older and jump pages keep their
  // turn-aware windows and use the SDK's original sequence cursor.
  replace('this.events=events;try{await events.open(HISTORY_PAGE_OPTIONS);',
    'this.events=events;try{await events.open({maxMessages:12});');
  replace('var SessionManager=class{remote;',
    `${SidebarTitles.toString()}\nvar SessionManager=class{sidebarTitles=new SidebarTitles;visibleOnlyReads=new Set;remote;`);
  replace('const connected=()=>{if(connection.generation.getSnapshot()===void 0)return;sessions.handleConnected();',
    'const connected=()=>{const generation=connection.generation.getSnapshot();if(generation===void 0){sessions.handleDisconnected();return}sessions.handleConnected(generation);');
  replace('handleConnected(){this.manager.handleConnected()}', `handleConnected(generation){this.manager.handleConnected(generation)}
    handleDisconnected(){this.manager.sidebarTitles.generation=null;this.manager.sidebarTitles.checked=false;this.manager.notifier.markDirty()}`);
  replace('handleConnected(){for(const store of this.projectionStores.values())store.clear();',
    'handleConnected(generation){this.sidebarTitles.connect(generation,()=>this.notifier.markDirty());for(const store of this.projectionStores.values())store.clear();');
  replace('this.summaries=summaries;const retained=this.retainedIds(summaries);', `this.summaries=summaries;
    this.sidebarTitles.reconcile(summaries);
    for(const old of established) if(!this.sidebarTitles.listed.has(old.sessionId)) {
      this.sidebarTitles.forget(old.sessionId);
      this.projectionStores.get(old.sessionId)?.forgetTitle();
      this.projectionInflight.get(old.sessionId)?.controller.abort();
      this.projectionInflight.delete(old.sessionId);
      this.projectionLoads.delete(old.sessionId);
      this.visibleOnlyReads.delete(old.sessionId);
    }
    const retained=this.retainedIds(summaries);`);
  replace('for(const s of result.value.items)if(s.projections!==void 0)',
    'for(const s of result.value.items)if(!removedSincePull.has(s.sessionId)&&s.projections!==void 0)');
  replace('clear(){for(const key of this.rows.keys())',
    'forgetTitle(){if(this.rows.delete(`title`))this.changed(`title`)}clear(){for(const key of this.rows.keys())');
  replace('if(durableSubagent)this.sessions.get(sessionId)?.handleRunning(false);else this.sessions.get(sessionId)?.handleRemoved();',
    `if(durableSubagent)this.sessions.get(sessionId)?.handleRunning(false);else {
      this.entryCache.delete(sessionId);this.sidebarTitles.listed.delete(sessionId);this.sidebarTitles.forget(sessionId);
      this.projectionStores.get(sessionId)?.forgetTitle();this.visibleOnlyReads.delete(sessionId);
      this.sessions.get(sessionId)?.handleRemoved();
    }`);
  replace('handleSessionAdded(summary){this.mergeSummary(summary);',
    'handleSessionAdded(summary){this.sidebarTitles.listed.set(summary.sessionId,summary.updatedAt);this.mergeSummary(summary);');
  replace('handleSessionActivity(sessionId,updatedAt){this.recordMutation(',
    'handleSessionActivity(sessionId,updatedAt){if(this.sidebarTitles.listed.has(sessionId))this.sidebarTitles.listed.set(sessionId,updatedAt);this.recordMutation(');
  replace('const title=projectionStore?.get(`title`);const projectionValues=projectionStore?.values();const metadata=projectionValues?.sessionListMetadata;return{...summary,blank:this.effectiveBlank(summary)&&metadata?.blank!==false,', `const rawTitle=projectionStore?.get('title');const projectionValues=projectionStore?.values();
    const blank=this.effectiveBlank(summary)&&projectionValues?.sessionListMetadata?.blank!==false;
    const exact=projectionStore?.seqOf('title')!==undefined || this.projectionLoads.get(summary.sessionId)?.state==='ready';
    const title=this.sidebarTitles.display(summary.sessionId,rawTitle,blank,exact,this.entryCache.get(summary.sessionId)?.title);
    const metadata=projectionValues?.sessionListMetadata;return{...summary,blank,`);

  // Visible rows get a passive exact read. Other SDK consumers still own their
  // original reconnect retry policy, including when they join an in-flight read.
  replace('refreshProjections(sessionId){const existing=this.projectionInflight.get(sessionId);', `
    titleNeedsRefresh(id){return this.sidebarTitles.checked && !!this.sidebarTitles.scope &&
      this.sidebarTitles.listed.has(id) && this.projectionStores.get(id)?.get('title')==null && !this.projectionLoads.has(id)}
    refreshVisibleTitle(id){if(this.disposed || !this.titleNeedsRefresh(id) ||
      !this.getListSnapshot().items.some(row=>row.sessionId===id && !row.blank)) return Promise.resolve();
      return this.refreshProjections(id,true)}
    refreshProjections(sessionId,visibleOnly=false){if(visibleOnly)this.visibleOnlyReads.add(sessionId);else this.visibleOnlyReads.delete(sessionId);
    const existing=this.projectionInflight.get(sessionId);`);
  replace('const parents=new Set(this.projectionLoads.keys());',
    'const parents=new Set([...this.projectionLoads.keys()].filter(id=>!this.visibleOnlyReads.has(id)));this.visibleOnlyReads.clear();');
  replace('refreshProjections(sessionId){return this.manager.refreshProjections(sessionId)}',
    'refreshVisibleTitle(id){return this.manager.refreshVisibleTitle(id)}refreshProjections(sessionId){return this.manager.refreshProjections(sessionId)}');
  replace('byId[entry.sessionId]={id:entry.sessionId,displayTitle:',
    'byId[entry.sessionId]={id:entry.sessionId,titleNeedsRefresh:!entry.blank&&this.manager.titleNeedsRefresh(entry.sessionId),displayTitle:');
  replace('async dispose(){this.disposed=true;this.listMutations=null;',
    'async dispose(){this.disposed=true;this.sidebarTitles.generation=null;this.listMutations=null;');
  return source;
}

module.exports = {transform};
