import * as childProcess from 'node:child_process';
import * as path from 'node:path';
import * as util from 'node:util';
import * as vscode from 'vscode';

const execFile = util.promisify(childProcess.execFile);
const API_KEY_SECRET = 'iny.commit.apiKey';
const DEFAULT_PROMPT = 'You write precise Git commit messages. Return only one Conventional Commit subject line in the requested language. Use a concise imperative verb, include an optional scope only when obvious, keep it under 72 characters, and do not include markdown, quotes, explanation, or a body.';

type ChatCompletion = {
  choices?: Array<{ message?: { content?: string } }>;
  error?: { message?: string };
};

export function activate(context: vscode.ExtensionContext): void {
  const homeViewProvider = new InyHomeViewProvider(context);
  context.subscriptions.push(
    vscode.commands.registerCommand('iny.openDashboard', () => vscode.commands.executeCommand('workbench.view.extension.iny')),
    vscode.commands.registerCommand('iny.commit.generate', (target?: unknown) => generate(false, context, target)),
    vscode.commands.registerCommand('iny.commit.generateAndCommit', (target?: unknown) => generate(true, context, target)),
    vscode.commands.registerCommand('iny.commit.setApiKey', () => setApiKey(context)),
    vscode.commands.registerCommand('iny.commit.openSettings', () => openSettings(context)),
    vscode.window.registerWebviewViewProvider('iny.home', homeViewProvider)
  );
}

async function generate(commitImmediately: boolean, context: vscode.ExtensionContext, target?: unknown): Promise<void> {
  const repository = await getActiveRepository(target);
  if (!repository) {
    vscode.window.showErrorMessage('Iny: open or focus a file in a Git repository first.');
    return;
  }

  try {
    const diff = await getStagedDiff(repository.rootUri.fsPath);
    if (!diff.trim()) {
      vscode.window.showWarningMessage('Iny: there are no staged changes. Stage changes before generating a message.');
      return;
    }

    const message = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Iny is reading staged changes…', cancellable: false },
      async () => generateMessage(diff, context)
    );

    if (commitImmediately) {
      const editedMessage = await vscode.window.showInputBox({
        title: 'Generated commit message',
        prompt: 'Review or edit the message before committing.',
        value: message,
        ignoreFocusOut: true,
        validateInput: (value) => value.trim() ? undefined : 'A commit message is required.'
      });
      if (!editedMessage) return;
      await commit(repository.rootUri.fsPath, editedMessage);
      vscode.window.showInformationMessage('Iny: commit created.');
      return;
    }

    const filledScmBox = await fillSourceControlInput(repository.rootUri, message);
    if (!filledScmBox) await vscode.env.clipboard.writeText(message);
    await vscode.commands.executeCommand('workbench.view.scm');
    vscode.window.showInformationMessage(
      filledScmBox
        ? 'Commit message added to the Source Control message box.'
        : 'Commit message copied to the clipboard. Paste it into the Source Control message box.'
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    vscode.window.showErrorMessage(`Iny: ${detail}`);
  }
}

type RepositoryLocation = { rootUri: vscode.Uri };

async function getActiveRepository(target?: unknown): Promise<RepositoryLocation | undefined> {
  const gitApi = await getGitApi();
  const targetUri = getUri(target);
  const activeUri = vscode.window.activeTextEditor?.document.uri;

  for (const uri of [targetUri, activeUri]) {
    if (!uri || uri.scheme !== 'file') continue;
    const repository = gitApi?.getRepository?.(uri);
    if (repository) return { rootUri: repository.rootUri };
    const resolvedAtUri = await findGitRepository(uri);
    if (resolvedAtUri) return resolvedAtUri;
    const resolved = await findGitRepository(vscode.Uri.file(path.dirname(uri.fsPath)));
    if (resolved) return resolved;
  }

  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (workspaceFolder) {
    const resolved = await findGitRepository(workspaceFolder.uri);
    if (resolved) return resolved;
  }
  const repository = gitApi?.repositories[0];
  return repository ? { rootUri: repository.rootUri } : undefined;
}

function getUri(value: unknown): vscode.Uri | undefined {
  if (value instanceof vscode.Uri) return value;
  if (!isRecord(value)) return undefined;
  for (const key of ['rootUri', 'resourceUri', 'uri']) {
    const uri = value[key];
    if (uri instanceof vscode.Uri) return uri;
  }
  return undefined;
}

async function findGitRepository(folder: vscode.Uri): Promise<RepositoryLocation | undefined> {
  try {
    const { stdout } = await execFile('git', ['rev-parse', '--show-toplevel'], { cwd: folder.fsPath });
    return { rootUri: vscode.Uri.file(stdout.trim()) };
  } catch {
    return undefined;
  }
}

async function getStagedDiff(cwd: string): Promise<string> {
  try {
    const { stdout } = await execFile('git', ['diff', '--cached', '--no-ext-diff', '--binary'], {
      cwd,
      maxBuffer: 5 * 1024 * 1024
    });
    return stdout;
  } catch {
    throw new Error('could not read the staged Git diff. Ensure the selected folder is a Git repository.');
  }
}

async function generateMessage(diff: string, context: vscode.ExtensionContext): Promise<string> {
  const config = vscode.workspace.getConfiguration('iny.commit');
  let apiKey = await context.secrets.get(API_KEY_SECRET);
  if (!apiKey) apiKey = config.get<string>('apiKey') || undefined;
  if (!apiKey) {
    const choice = await vscode.window.showWarningMessage('An API key is needed to generate a commit message.', 'Set API Key');
    if (choice === 'Set API Key') await setApiKey(context);
    apiKey = await context.secrets.get(API_KEY_SECRET);
    if (!apiKey) throw new Error('API key was not configured.');
  }

  const maxChars = config.get<number>('maxDiffChars', 12000);
  const clippedDiff = diff.length > maxChars
    ? `${diff.slice(0, maxChars)}\n\n[Diff truncated]`
    : diff;
  const language = config.get<string>('language', 'Auto');
  const endpoint = config.get<string>('apiEndpoint') || 'https://api.openai.com/v1/chat/completions';
  const model = config.get<string>('model') || 'gpt-4o-mini';
  const prompt = config.get<string>('prompt') || DEFAULT_PROMPT;

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      messages: [
        {
          role: 'system',
          content: prompt
        },
        {
          role: 'user',
          content: `Requested language: ${language}.\n\nGenerate a commit subject for these staged changes:\n\n${clippedDiff}`
        }
      ]
    })
  });

  const body = await response.json() as ChatCompletion;
  if (!response.ok) throw new Error(body.error?.message || `AI request failed (${response.status}).`);
  const content = body.choices?.[0]?.message?.content?.trim();
  if (!content) throw new Error('the AI provider returned no commit message.');
  return content.split('\n')[0].replace(/^['"`]|['"`]$/g, '').trim();
}

async function setApiKey(context: vscode.ExtensionContext): Promise<void> {
  const apiKey = await vscode.window.showInputBox({
    title: 'Iny AI API Key',
    prompt: 'Stored securely in VS Code Secret Storage.',
    password: true,
    ignoreFocusOut: true
  });
  if (!apiKey) return;
  await context.secrets.store(API_KEY_SECRET, apiKey.trim());
  vscode.window.showInformationMessage('Iny: API key saved securely.');
}

type Settings = {
  apiEndpoint: string;
  model: string;
  language: string;
  maxDiffChars: number;
  prompt: string;
  hasApiKey: boolean;
};

async function openSettings(context: vscode.ExtensionContext): Promise<void> {
  const panel = vscode.window.createWebviewPanel(
    'iny.commit.settings',
    'Iny · Commit Assistant',
    vscode.ViewColumn.One,
    { enableScripts: true }
  );
  const settings = await getSettings(context);
  panel.webview.html = settingsHtml(settings);
  panel.webview.onDidReceiveMessage(async (message: unknown) => {
    if (!isRecord(message)) return;
    if (message.type === 'save') {
      const result = await saveSettings(message, context);
      panel.webview.postMessage(result);
      if (result.ok) vscode.window.showInformationMessage('Iny: configuration saved.');
    }
    if (message.type === 'openNativeSettings') {
      await vscode.commands.executeCommand('workbench.action.openSettings', 'Iny Toolkit');
    }
  }, undefined, context.subscriptions);
}

async function getSettings(context: vscode.ExtensionContext): Promise<Settings> {
  const config = vscode.workspace.getConfiguration('iny.commit');
  return {
    apiEndpoint: config.get<string>('apiEndpoint') || 'https://api.openai.com/v1/chat/completions',
    model: config.get<string>('model') || 'gpt-4o-mini',
    language: config.get<string>('language') || 'Auto',
    maxDiffChars: config.get<number>('maxDiffChars') || 12000,
    prompt: config.get<string>('prompt') || DEFAULT_PROMPT,
    hasApiKey: Boolean(await context.secrets.get(API_KEY_SECRET))
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

async function saveSettings(message: Record<string, unknown>, context: vscode.ExtensionContext): Promise<{ ok: boolean; error?: string }> {
  const endpoint = typeof message.apiEndpoint === 'string' ? message.apiEndpoint.trim() : '';
  const model = typeof message.model === 'string' ? message.model.trim() : '';
  const prompt = typeof message.prompt === 'string' ? message.prompt.trim() : '';
  const language = typeof message.language === 'string' ? message.language : 'Auto';
  const maxDiffChars = Number(message.maxDiffChars);
  const apiKey = typeof message.apiKey === 'string' ? message.apiKey.trim() : '';
  if (!endpoint || !model || !prompt) return { ok: false, error: 'Endpoint、模型和 Prompt 不能为空。' };
  if (!Number.isFinite(maxDiffChars) || maxDiffChars < 1000 || maxDiffChars > 100000) {
    return { ok: false, error: '最大 Diff 长度必须在 1,000 到 100,000 之间。' };
  }
  const config = vscode.workspace.getConfiguration('iny.commit');
  await Promise.all([
    config.update('apiEndpoint', endpoint, vscode.ConfigurationTarget.Global),
    config.update('model', model, vscode.ConfigurationTarget.Global),
    config.update('prompt', prompt, vscode.ConfigurationTarget.Global),
    config.update('language', language, vscode.ConfigurationTarget.Global),
    config.update('maxDiffChars', maxDiffChars, vscode.ConfigurationTarget.Global)
  ]);
  if (apiKey) await context.secrets.store(API_KEY_SECRET, apiKey);
  return { ok: true };
}

function settingsHtml(settings: Settings): string {
  const safe = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  body { color: var(--vscode-foreground); font-family: var(--vscode-font-family); max-width: 760px; margin: 28px auto; padding: 0 20px; }
  h1 { font-size: 22px; } p { color: var(--vscode-descriptionForeground); line-height: 1.5; }
  label { display: block; font-weight: 600; margin: 20px 0 7px; } input, select, textarea { box-sizing: border-box; width: 100%; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border); padding: 8px; font: inherit; }
  textarea { min-height: 160px; resize: vertical; } .hint { font-size: 12px; margin: 6px 0; } .row { display: grid; grid-template-columns: 1fr 180px; gap: 16px; }
  button { color: var(--vscode-button-foreground); background: var(--vscode-button-background); border: 0; padding: 9px 15px; margin: 24px 8px 0 0; cursor: pointer; font: inherit; } button:hover { background: var(--vscode-button-hoverBackground); } #status { margin-left: 8px; }
</style></head><body>
<h1>Iny · Commit Assistant</h1><p>选择任意 OpenAI 兼容服务，设置模型和生成提交信息时使用的系统 Prompt。API Key 仅保存到 VS Code 的 Secret Storage，不会显示或写入设置文件。</p>
<label for="endpoint">API Endpoint</label><input id="endpoint" value="${safe(settings.apiEndpoint)}" placeholder="https://api.openai.com/v1/chat/completions">
<div class="row"><div><label for="model">模型</label><input id="model" value="${safe(settings.model)}" placeholder="gpt-4o-mini"></div><div><label for="language">输出语言</label><select id="language">${['Auto', 'Chinese', 'English', 'Japanese'].map(value => `<option ${settings.language === value ? 'selected' : ''}>${value}</option>`).join('')}</select></div></div>
<label for="apiKey">API Key ${settings.hasApiKey ? '（已配置；留空则保留）' : ''}</label><input id="apiKey" type="password" placeholder="输入新 Key 以保存">
<label for="prompt">自定义 Prompt</label><textarea id="prompt">${safe(settings.prompt)}</textarea><p class="hint">Prompt 会作为 system message 直接发送给模型。请要求模型只返回提交标题，以确保能直接用于 Git 提交。</p>
<label for="maxDiffChars">最大 Diff 长度</label><input id="maxDiffChars" type="number" min="1000" max="100000" value="${settings.maxDiffChars}">
<button id="save">保存配置</button><button id="native">打开 VS Code 设置</button><span id="status"></span>
<script>
  const vscode = acquireVsCodeApi(); const $ = id => document.getElementById(id);
  $('save').addEventListener('click', () => vscode.postMessage({ type: 'save', apiEndpoint: $('endpoint').value, model: $('model').value, language: $('language').value, apiKey: $('apiKey').value, prompt: $('prompt').value, maxDiffChars: $('maxDiffChars').value }));
  $('native').addEventListener('click', () => vscode.postMessage({ type: 'openNativeSettings' }));
  window.addEventListener('message', event => { const message = event.data; $('status').textContent = message.ok ? '已保存' : message.error || '保存失败'; });
</script></body></html>`;
}

/** The toolkit home is intentionally command-driven: new personal workflows can share this shell. */
class InyHomeViewProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {
    context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration('iny.commit') || event.affectsConfiguration('iny.profile')) {
          void this.refresh();
        }
      })
    );
  }

  async resolveWebviewView(view: vscode.WebviewView): Promise<void> {
    this.view = view;
    view.webview.options = { enableScripts: true };
    await this.refresh();
    view.webview.onDidReceiveMessage(async (message: unknown) => {
      if (!isRecord(message) || typeof message.command !== 'string') return;
      const commands: Record<string, string> = {
        generate: 'iny.commit.generate',
        generateAndCommit: 'iny.commit.generateAndCommit',
        configureCommit: 'iny.commit.openSettings'
      };
      const command = commands[message.command];
      if (command) await vscode.commands.executeCommand(command);
    }, undefined, this.context.subscriptions);
  }

  private async refresh(): Promise<void> {
    if (!this.view) return;
    const displayName = vscode.workspace.getConfiguration('iny.profile').get<string>('displayName') || 'iny';
    this.view.webview.html = dashboardHtml(displayName, await getSettings(this.context));
  }
}

function dashboardHtml(displayName: string, settings: Settings): string {
  const safe = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const keyStatus = settings.hasApiKey ? '已连接 API Key' : '尚未配置 API Key';
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  body { color: var(--vscode-foreground); font-family: var(--vscode-font-family); padding: 0 12px; }
  h2 { font-size: 17px; margin: 16px 0 4px; } .sub { color: var(--vscode-descriptionForeground); font-size: 12px; line-height: 1.5; margin: 0 0 18px; }
  .card { border: 1px solid var(--vscode-panel-border); border-radius: 5px; padding: 12px; margin: 10px 0; } .card h3 { font-size: 14px; margin: 0 0 6px; }
  .card p { color: var(--vscode-descriptionForeground); font-size: 12px; line-height: 1.45; margin: 0 0 10px; } button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: 0; border-radius: 2px; padding: 6px 8px; margin: 2px 4px 0 0; cursor: pointer; font: inherit; font-size: 12px; } button:hover { background: var(--vscode-button-hoverBackground); }
  .meta { color: var(--vscode-descriptionForeground); font-size: 11px; margin-top: 18px; }
</style></head><body>
<h2>${safe(displayName)}'s Toolkit</h2><p class="sub">一个为个人工作流持续演进的 VS Code 工具箱。</p>
<section class="card"><h3>AI Commit Assistant</h3><p>基于暂存变更生成可编辑的 Conventional Commit 信息。当前模型：${safe(settings.model)}。</p><button data-command="generate">生成 Commit Message</button><button data-command="generateAndCommit">生成并提交</button><button data-command="configureCommit">配置</button></section>
<p class="meta">${keyStatus} · 新功能将以独立工作流模块加入这里。</p>
<script>const vscode = acquireVsCodeApi(); document.querySelectorAll('button[data-command]').forEach(button => button.addEventListener('click', () => vscode.postMessage({command: button.dataset.command})));</script>
</body></html>`;
}

async function commit(cwd: string, message: string): Promise<void> {
  try {
    await execFile('git', ['commit', '-m', message], { cwd, maxBuffer: 1024 * 1024 });
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr?.trim();
    throw new Error(stderr || 'Git could not create the commit.');
  }
}

type GitRepository = {
  rootUri: vscode.Uri;
  inputBox: { value: string };
};

type GitApi = {
  repositories: GitRepository[];
  getRepository?(uri: vscode.Uri): GitRepository | null | undefined;
};

async function getGitApi(): Promise<GitApi | undefined> {
  const gitExtension = vscode.extensions.getExtension<{ getAPI(version: 1): GitApi }>('vscode.git');
  if (!gitExtension) return undefined;
  if (!gitExtension.isActive) await gitExtension.activate();
  return gitExtension.exports.getAPI(1);
}

/** Use the built-in Git extension when it is available, without making it a hard dependency. */
async function fillSourceControlInput(folder: vscode.Uri, message: string): Promise<boolean> {
  const gitApi = await getGitApi();
  if (!gitApi) return false;
  const repositories = gitApi.repositories;
  const repository = repositories.find(({ rootUri }) =>
    folder.fsPath.startsWith(rootUri.fsPath) || rootUri.fsPath.startsWith(folder.fsPath)
  );
  if (!repository) return false;
  repository.inputBox.value = message;
  return true;
}

export function deactivate(): void {}
