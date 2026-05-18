const path = require('path');
const vscode = require('vscode');
const { LanguageClient, TransportKind } = require('vscode-languageclient/node');

let client;

function activate(context) {
  const serverModule = context.asAbsolutePath(path.join('server', 'server.js'));

  const serverOptions = {
    run: { module: serverModule, transport: TransportKind.ipc },
    debug: { module: serverModule, transport: TransportKind.ipc }
  };

  const clientOptions = {
    documentSelector: [{ scheme: 'file', language: 'em4script' }],
    initializationOptions: {
      bundledSdkPath: context.asAbsolutePath(path.join('sdk'))
    },
    synchronize: {
      fileEvents: vscode.workspace.createFileSystemWatcher('**/*.script')
    }
  };

  client = new LanguageClient(
    'em4ScriptLanguageServer',
    'EM4 Script Language Server',
    serverOptions,
    clientOptions
  );

  context.subscriptions.push(client.start());
}

async function deactivate() {
  if (!client) {
    return undefined;
  }
  return client.stop();
}

module.exports = {
  activate,
  deactivate
};
