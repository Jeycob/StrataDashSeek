const sessionId = document.documentElement.dataset.session;
const language = document.documentElement.lang;
const notify = (state) => window.parent.postMessage({ type: 'homeai-codeoss', sessionId, state }, location.origin);

if (!sessionId) {
  notify('unavailable');
} else {
  const runtime = new URL('./vscode/', import.meta.url);
  globalThis._VSCODE_FILE_ROOT = runtime.href;
  globalThis._VSCODE_NLS_LANGUAGE = language;
  try {
    const { create, URI } = await import(new URL('vs/workbench/workbench.web.main.internal.js', runtime));
    const folder = URI.from({ scheme: 'homeai', authority: sessionId, path: '/Project' });
    create(document.body, {
      productConfiguration: {
        nameShort: 'Code - OSS',
        nameLong: 'Code - OSS',
        enableTelemetry: false,
        extensionsGallery: undefined,
        webEndpointUrlTemplate: undefined,
      },
      workspaceProvider: {
        workspace: { folderUri: folder },
        trusted: false,
        open: async () => false,
      },
      additionalBuiltinExtensions: [URI.parse(new URL('./project/', import.meta.url).href)],
      webviewEndpoint: new URL('vs/workbench/contrib/webview/browser/pre', runtime).href,
      configurationDefaults: {
        'files.autoSave': 'off',
        'files.hotExit': 'onExitAndWindowClose',
        'workbench.startupEditor': 'none',
        'workbench.secondarySideBar.defaultVisibility': 'hidden',
        'workbench.activityBar.location': 'hidden',
        'workbench.editor.enablePreview': false,
        'extensions.autoCheckUpdates': false,
        'extensions.autoUpdate': false,
        'telemetry.telemetryLevel': 'off',
        'security.workspace.trust.enabled': false,
        'update.mode': 'none',
        'git.autofetch': false,
      },
    });
    // create() returns a disposable while the workbench opens asynchronously.
    const ready = new MutationObserver(() => {
      if (!document.querySelector('.monaco-workbench .part.editor')) return;
      ready.disconnect();
      notify('ready');
    });
    ready.observe(document.body, { childList: true, subtree: true });
  } catch (error) {
    console.error('Code-OSS failed to start', error);
    notify('unavailable');
  }
}
