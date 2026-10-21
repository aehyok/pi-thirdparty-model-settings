/**
 * API Config Extension
 *
 * /dsf-config 打开一个本地网页，填写第三方 API（baseUrl / apiKey / 模型），
 * 提交后写入 <agent-dir>/models.json，随后 /model 即可看到新模型。
 *
 * 安装：复制到 ~/.pi/agent/extensions/，或 pi --extension ./api-config.ts
 */

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync, copyFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

const IDLE_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_BODY_BYTES = 1024 * 1024;
const KEEP_KEY = "__KEEP_EXISTING_KEY__";
const APIS = ["openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai"];

type ModelEntry = {
	id: string;
	name?: string;
	reasoning?: boolean;
	input?: string[];
	contextWindow?: number;
	maxTokens?: number;
	[key: string]: unknown;
};

type ProviderEntry = {
	baseUrl?: string;
	api?: string;
	apiKey?: string;
	models?: ModelEntry[];
	[key: string]: unknown;
};

type ModelsFile = { $schema?: string; providers: Record<string, ProviderEntry>; [key: string]: unknown };

function modelsPath(): string {
	return join(getAgentDir(), "models.json");
}

function readModelsFile(): ModelsFile {
	const path = modelsPath();
	if (!existsSync(path)) return { $schema: "https://pi.dev/schemas/models.schema.json", providers: {} };
	const text = readFileSync(path, "utf8");
	if (!text.trim()) return { $schema: "https://pi.dev/schemas/models.schema.json", providers: {} };
	// 解析失败直接抛错，绝不覆盖用户手写的文件
	const data = JSON.parse(text) as ModelsFile;
	if (!data.providers || typeof data.providers !== "object") data.providers = {};
	return data;
}

function writeModelsFile(data: ModelsFile): void {
	const path = modelsPath();
	if (existsSync(path)) copyFileSync(path, `${path}.bak`);
	const tmp = `${path}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
	renameSync(tmp, path);
}

function maskKey(key: string | undefined): string {
	if (!key) return "";
	if (key.startsWith("$") || key.startsWith("!")) return key; // 环境变量 / 命令引用，原样展示
	if (key.length <= 8) return "****";
	return `${key.slice(0, 4)}****${key.slice(-4)}`;
}

/** 把 apiKey 中的 $ENV / ${ENV} 引用解析成真实值，仅用于“获取模型列表” */
function resolveKey(key: string): string {
	const m = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/.exec(key);
	if (m) return process.env[m[1]] ?? "";
	return key;
}

function openBrowser(url: string): void {
	const [cmd, args] =
		process.platform === "win32"
			? ["rundll32", ["url.dll,FileProtocolHandler", url]]
			: process.platform === "darwin"
				? ["open", [url]]
				: ["xdg-open", [url]];
	try {
		const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
		child.on("error", () => {});
		child.unref();
	} catch {
		// 打不开浏览器时用户可手动复制链接
	}
}

function readBody(req: IncomingMessage): Promise<unknown> {
	return new Promise((resolve, reject) => {
		let size = 0;
		const chunks: Buffer[] = [];
		req.on("data", (c: Buffer) => {
			size += c.length;
			if (size > MAX_BODY_BYTES) {
				reject(new Error("请求体过大"));
				req.destroy();
				return;
			}
			chunks.push(c);
		});
		req.on("end", () => {
			try {
				resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
			} catch {
				reject(new Error("请求体不是合法 JSON"));
			}
		});
		req.on("error", reject);
	});
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
	res.end(JSON.stringify(body));
}

function listProviders() {
	const data = readModelsFile();
	return Object.entries(data.providers).map(([name, p]) => ({
		name,
		baseUrl: p.baseUrl ?? "",
		api: p.api ?? "",
		apiKeyMasked: maskKey(p.apiKey),
		hasKey: Boolean(p.apiKey),
		models: (p.models ?? []).map((m) => ({
			id: m.id,
			name: m.name ?? "",
			reasoning: Boolean(m.reasoning),
			image: Array.isArray(m.input) && m.input.includes("image"),
			contextWindow: m.contextWindow ?? "",
			maxTokens: m.maxTokens ?? "",
		})),
	}));
}

async function fetchRemoteModels(body: { baseUrl?: string; api?: string; apiKey?: string; provider?: string }) {
	const baseUrl = (body.baseUrl ?? "").trim().replace(/\/+$/, "");
	if (!/^https?:\/\//i.test(baseUrl)) throw new Error("baseUrl 需以 http:// 或 https:// 开头");
	let key = (body.apiKey ?? "").trim();
	if (key === KEEP_KEY && body.provider) key = readModelsFile().providers[body.provider]?.apiKey ?? "";
	key = resolveKey(key);
	if (key.startsWith("!")) throw new Error("命令形式的 apiKey 无法用于获取模型列表，请手动填写模型 ID");

	const headers: Record<string, string> = {};
	if (body.api === "anthropic-messages") {
		if (key) headers["x-api-key"] = key;
		headers["anthropic-version"] = "2023-06-01";
	} else if (body.api === "google-generative-ai") {
		if (key) headers["x-goog-api-key"] = key;
	} else if (key) {
		headers.Authorization = `Bearer ${key}`;
	}

	const res = await fetch(`${baseUrl}/models`, { headers, signal: AbortSignal.timeout(15000) });
	const text = await res.text();
	if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
	const json = JSON.parse(text) as { data?: { id?: string }[]; models?: { name?: string; id?: string }[] };
	const ids = [
		...(json.data ?? []).map((m) => m.id),
		...(json.models ?? []).map((m) => m.id ?? m.name?.replace(/^models\//, "")),
	].filter((id): id is string => Boolean(id));
	return [...new Set(ids)].sort();
}

type SaveBody = {
	provider?: string;
	originalProvider?: string;
	baseUrl?: string;
	api?: string;
	apiKey?: string;
	models?: { id?: string; name?: string; reasoning?: boolean; image?: boolean; contextWindow?: unknown; maxTokens?: unknown }[];
};

function positiveNumber(v: unknown): number | undefined {
	const n = typeof v === "number" ? v : Number(String(v ?? "").trim());
	return Number.isFinite(n) && n > 0 ? n : undefined;
}

function saveProvider(body: SaveBody): { provider: string; models: string[]; renamedFrom?: string } {
	const provider = (body.provider ?? "").trim();
	if (!/^[A-Za-z0-9._-]+$/.test(provider)) throw new Error("provider 名称只能包含字母、数字、. _ -");
	const baseUrl = (body.baseUrl ?? "").trim().replace(/\/+$/, "");
	if (!/^https?:\/\//i.test(baseUrl)) throw new Error("baseUrl 需以 http:// 或 https:// 开头");
	const api = (body.api ?? "").trim();
	if (!api) throw new Error("请选择接口类型");

	const seen = new Set<string>();
	const rows = (body.models ?? []).filter((m) => {
		const id = (m.id ?? "").trim();
		if (!id || seen.has(id)) return false;
		seen.add(id);
		return true;
	});
	if (rows.length === 0) throw new Error("至少填写一个模型 ID");

	const data = readModelsFile();
	const original = (body.originalProvider ?? "").trim();
	const existing = data.providers[original || provider] ?? data.providers[provider];

	let apiKey = (body.apiKey ?? "").trim();
	if (apiKey === KEEP_KEY) apiKey = existing?.apiKey ?? "";
	if (!apiKey) throw new Error("apiKey 不能为空（本地服务不需要 key 时可随便填，例如 none）");

	// 保留已有模型上的其他字段（cost、compat 等），只覆盖表单中的字段
	const oldModels = new Map((existing?.models ?? []).map((m) => [m.id, m]));
	const models: ModelEntry[] = rows.map((r) => {
		const id = (r.id ?? "").trim();
		const m: ModelEntry = { ...(oldModels.get(id) ?? {}), id };
		const name = (r.name ?? "").trim();
		if (name) m.name = name;
		else delete m.name;
		m.reasoning = Boolean(r.reasoning);
		m.input = r.image ? ["text", "image"] : ["text"];
		const ctxWin = positiveNumber(r.contextWindow);
		if (ctxWin) m.contextWindow = ctxWin;
		else delete m.contextWindow;
		const maxTokens = positiveNumber(r.maxTokens);
		if (maxTokens) m.maxTokens = maxTokens;
		else delete m.maxTokens;
		return m;
	});

	if (original && original !== provider) delete data.providers[original];
	data.providers[provider] = { ...(existing ?? {}), baseUrl, api, apiKey, models };
	writeModelsFile(data);
	return { provider, models: models.map((m) => m.id), renamedFrom: original && original !== provider ? original : undefined };
}

function deleteProvider(name: string): void {
	const data = readModelsFile();
	if (!data.providers[name]) throw new Error(`provider "${name}" 不存在`);
	delete data.providers[name];
	writeModelsFile(data);
}

export default function apiConfigExtension(pi: ExtensionAPI) {
	let server: Server | undefined;
	let url: string | undefined;
	let idleTimer: ReturnType<typeof setTimeout> | undefined;

	const stop = () => {
		if (idleTimer) clearTimeout(idleTimer);
		idleTimer = undefined;
		server?.close();
		server?.closeAllConnections?.();
		server = undefined;
		url = undefined;
	};

	pi.on("session_shutdown", async () => stop());

	pi.registerCommand("dsf-config", {
		description: "在浏览器中配置第三方 API（baseUrl / apiKey / 模型）",
		handler: async (args, ctx) => {
			if (args.trim() === "stop") {
				stop();
				ctx.ui.notify("API 配置页已关闭", "info");
				return;
			}
			if (server && url) {
				openBrowser(url);
				ctx.ui.notify(`配置页已在运行：${url}`, "info");
				return;
			}

			const ui = ctx.ui;
			const registry = ctx.modelRegistry;
			// /model 自带的全量刷新会等所有服务商联网（openrouter 等较慢），超时后新 provider
			// 永远不会被标记为可用；这里只针对改动的 provider 做本地刷新，立即生效
			const refreshProviders = async (providers: string[]) => {
				try {
					await registry.refresh({ providers, allowNetwork: false });
				} catch (err) {
					ui.notify(`已写入 models.json，但刷新模型列表失败：${err instanceof Error ? err.message : String(err)}（重启 pi 即可）`, "warning");
				}
			};
			const token = randomBytes(16).toString("hex");
			const base = `/${token}`;
			const touch = () => {
				if (idleTimer) clearTimeout(idleTimer);
				idleTimer = setTimeout(() => {
					stop();
					ui.notify("API 配置页闲置超时，已自动关闭", "info");
				}, IDLE_TIMEOUT_MS);
			};

			const srv = createServer(async (req, res) => {
				const path = (req.url ?? "/").split("?")[0];
				// token 写在路径里，挡住其他网页对本地端口的跨站请求
				if (path !== base && !path.startsWith(`${base}/`)) {
					res.writeHead(404).end();
					return;
				}
				touch();
				const route = `${req.method} ${path.slice(base.length) || "/"}`;
				try {
					switch (route) {
						case "GET /":
							res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
							res.end(PAGE_HTML.replace("__KEEP_KEY__", KEEP_KEY).replace("__APIS__", JSON.stringify(APIS)));
							return;
						case "GET /api/providers":
							sendJson(res, 200, { path: modelsPath(), providers: listProviders() });
							return;
						case "POST /api/fetch-models": {
							const ids = await fetchRemoteModels((await readBody(req)) as Record<string, string>);
							sendJson(res, 200, { ids });
							return;
						}
						case "POST /api/save": {
							const result = saveProvider((await readBody(req)) as SaveBody);
							await refreshProviders(result.renamedFrom ? [result.provider, result.renamedFrom] : [result.provider]);
							ui.notify(`已保存 ${result.provider}：${result.models.join(", ")}，输入 /model 查看`, "info");
							sendJson(res, 200, result);
							return;
						}
						case "POST /api/delete": {
							const { name } = (await readBody(req)) as { name?: string };
							deleteProvider(String(name ?? ""));
							await refreshProviders([String(name)]);
							ui.notify(`已删除 provider ${name}`, "info");
							sendJson(res, 200, { ok: true });
							return;
						}
						case "POST /api/close":
							sendJson(res, 200, { ok: true });
							setTimeout(stop, 50);
							ui.notify("API 配置页已关闭", "info");
							return;
						default:
							res.writeHead(404).end();
					}
				} catch (err) {
					sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
				}
			});

			await new Promise<void>((resolve, reject) => {
				srv.once("error", reject);
				srv.listen(0, "127.0.0.1", () => resolve());
			});
			const address = srv.address();
			if (!address || typeof address === "string") {
				srv.close();
				ui.notify("启动本地服务失败", "error");
				return;
			}
			server = srv;
			url = `http://127.0.0.1:${address.port}${base}/`;
			touch();
			openBrowser(url);
			ui.notify(`已在浏览器打开 API 配置页：${url}\n（/dsf-config stop 可关闭）`, "info");
		},
	});
}

const PAGE_HTML = String.raw`<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pi 模型配置</title>
<script>
// 首屏前应用主题，避免闪烁
try { const t = localStorage.getItem("pi-apiconfig-theme"); if (t === "light" || t === "dark") document.documentElement.dataset.theme = t; } catch {}
</script>
<style>
:root{
  --bg:#f5f5f7;--surface:#ffffff;--surface-2:#fafafb;--fg:#18181b;--fg-2:#52525b;--muted:#8a8a93;
  --line:#e7e7ea;--line-2:#d9d9de;--accent:#5b5bd6;--accent-fg:#fff;--accent-soft:rgba(91,91,214,.10);
  --danger:#d93d42;--danger-soft:rgba(217,61,66,.08);--ok:#1f9d55;
  --shadow:0 1px 2px rgba(16,16,24,.04),0 4px 16px rgba(16,16,24,.04);
  --radius:12px;--mono:ui-monospace,"Cascadia Code","JetBrains Mono",Consolas,monospace;
}
:root{color-scheme:light}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){
  color-scheme:dark;
  --bg:#0e0e11;--surface:#16161a;--surface-2:#1b1b20;--fg:#ededf0;--fg-2:#b4b4bc;--muted:#7c7c86;
  --line:#26262c;--line-2:#33333b;--accent:#8b8bf5;--accent-fg:#0e0e11;--accent-soft:rgba(139,139,245,.14);
  --danger:#f2777b;--danger-soft:rgba(242,119,123,.10);--ok:#4ade80;--shadow:0 1px 2px rgba(0,0,0,.3);
}}
:root[data-theme="dark"]{
  color-scheme:dark;
  --bg:#0e0e11;--surface:#16161a;--surface-2:#1b1b20;--fg:#ededf0;--fg-2:#b4b4bc;--muted:#7c7c86;
  --line:#26262c;--line-2:#33333b;--accent:#8b8bf5;--accent-fg:#0e0e11;--accent-soft:rgba(139,139,245,.14);
  --danger:#f2777b;--danger-soft:rgba(242,119,123,.10);--ok:#4ade80;--shadow:0 1px 2px rgba(0,0,0,.3);
}
body,.panel,.input,.btn,.pill span,.chip,.seg,.seg button{transition:background-color .2s,border-color .2s,color .2s}

/* theme switch */
.theme{display:inline-flex;gap:2px;padding:3px;border-radius:9px;background:var(--surface-2);border:1px solid var(--line)}
.theme button{width:30px;height:28px;border:none;border-radius:6px;background:none;color:var(--muted);cursor:pointer;display:grid;place-items:center}
.theme button:hover{color:var(--fg)}
.theme button.on{background:var(--surface);color:var(--accent);box-shadow:0 1px 2px rgba(0,0,0,.12)}
.theme svg{width:15px;height:15px;stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
*{box-sizing:border-box}
html,body{margin:0;background:var(--bg);color:var(--fg)}
body{font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;-webkit-font-smoothing:antialiased}
button,input{font:inherit;color:inherit}
.app{max-width:1120px;margin:0 auto;padding:28px 20px 40px}

/* header */
.top{display:flex;align-items:center;gap:14px;margin-bottom:24px}
.logo{width:36px;height:36px;border-radius:10px;background:var(--accent);color:var(--accent-fg);display:grid;place-items:center;font-weight:700;font-size:17px;flex:none}
.top h1{font-size:17px;font-weight:650;margin:0;letter-spacing:-.01em}
.path{font:12px/1.4 var(--mono);color:var(--muted);margin-top:2px;word-break:break-all}
.top .sp{flex:1}

/* layout */
.layout{display:grid;grid-template-columns:264px minmax(0,1fr);gap:20px;align-items:start}
@media (max-width:820px){.layout{grid-template-columns:1fr}}
.panel{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);box-shadow:var(--shadow)}

/* sidebar */
.side{padding:14px;position:sticky;top:20px}
.side-h{display:flex;align-items:center;justify-content:space-between;padding:2px 4px 10px}
.eyebrow{font-size:12px;font-weight:600;color:var(--muted);letter-spacing:.04em}
.plist{display:flex;flex-direction:column;gap:4px}
.pitem{display:flex;align-items:center;gap:10px;padding:9px 10px;border-radius:9px;cursor:pointer;border:1px solid transparent;text-align:left;background:none;width:100%}
.pitem:hover{background:var(--surface-2)}
.pitem.active{background:var(--accent-soft);border-color:transparent}
.pav{width:30px;height:30px;border-radius:8px;background:var(--surface-2);border:1px solid var(--line);display:grid;place-items:center;font-weight:650;font-size:13px;color:var(--fg-2);flex:none;text-transform:uppercase}
.pitem.active .pav{background:var(--accent);border-color:var(--accent);color:var(--accent-fg)}
.pbody{min-width:0;flex:1}
.pname{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.psub{font-size:12px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.empty{padding:18px 8px;text-align:center;color:var(--muted);font-size:13px}

/* main form */
.main{overflow:hidden}
.sec{padding:22px 24px;border-bottom:1px solid var(--line)}
.sec:last-of-type{border-bottom:none}
.sec-h{display:flex;align-items:center;gap:12px;margin-bottom:16px}
.sec-h h2{font-size:15px;font-weight:650;margin:0}
.sec-h .desc{color:var(--muted);font-size:13px}
.sec-h .sp{flex:1}
.title-row{display:flex;align-items:baseline;gap:10px}
.badge{font-size:11px;font-weight:600;padding:2px 8px;border-radius:999px;background:var(--surface-2);border:1px solid var(--line);color:var(--fg-2)}
.fields{display:grid;grid-template-columns:1fr 1fr;gap:16px 18px}
.full{grid-column:1/-1}
@media (max-width:620px){.fields{grid-template-columns:1fr}}
.field label,.flabel{display:block;font-size:13px;font-weight:550;color:var(--fg-2);margin-bottom:6px}
.hint{font-size:12px;color:var(--muted);margin-top:6px}
.input{width:100%;height:38px;padding:0 12px;border:1px solid var(--line-2);border-radius:9px;background:var(--surface);transition:border-color .15s,box-shadow .15s}
.input::placeholder{color:var(--muted)}
.input:hover{border-color:var(--muted)}
.input:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}
.input.mono{font-family:var(--mono);font-size:13px}
.input.invalid{border-color:var(--danger);box-shadow:0 0 0 3px var(--danger-soft)}
.with-btn{position:relative}
.with-btn .input{padding-right:64px}
.with-btn .in-btn{position:absolute;right:5px;top:5px;height:28px;padding:0 10px;border-radius:6px;border:none;background:var(--surface-2);color:var(--fg-2);font-size:12px;cursor:pointer}
.with-btn .in-btn:hover{color:var(--fg)}

/* segmented */
.seg{display:grid;grid-template-columns:repeat(4,1fr);gap:4px;padding:4px;border-radius:10px;background:var(--surface-2);border:1px solid var(--line)}
@media (max-width:620px){.seg{grid-template-columns:1fr 1fr}}
.seg button{border:none;background:none;border-radius:7px;padding:7px 8px;cursor:pointer;text-align:center;line-height:1.25}
.seg button b{display:block;font-size:13px;font-weight:600}
.seg button small{display:block;font:11px var(--mono);color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.seg button:hover{background:var(--surface)}
.seg button.on{background:var(--surface);box-shadow:0 1px 3px rgba(0,0,0,.12);outline:1px solid var(--line-2)}
.seg button.on b{color:var(--accent)}

/* buttons */
.btn{height:36px;padding:0 14px;border-radius:9px;border:1px solid var(--line-2);background:var(--surface);cursor:pointer;font-weight:550;display:inline-flex;align-items:center;gap:6px;white-space:nowrap;transition:background .15s,border-color .15s,opacity .15s}
.btn:hover{background:var(--surface-2);border-color:var(--muted)}
.btn:disabled{opacity:.55;cursor:default}
.btn.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-fg)}
.btn.primary:hover{filter:brightness(1.06)}
.btn.ghost{border-color:transparent;background:none;color:var(--fg-2)}
.btn.ghost:hover{background:var(--surface-2);color:var(--fg)}
.btn.danger{border-color:transparent;background:none;color:var(--danger)}
.btn.danger:hover{background:var(--danger-soft)}
.btn.sm{height:30px;padding:0 10px;font-size:13px;border-radius:8px}
.btn.block{width:100%;justify-content:center;border-style:dashed;color:var(--fg-2)}
.spin{width:14px;height:14px;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;animation:sp .7s linear infinite;display:none}
.loading .spin{display:inline-block}
@keyframes sp{to{transform:rotate(360deg)}}

/* models */
.mgrid{display:grid;grid-template-columns:minmax(150px,1.4fr) minmax(120px,1.1fr) 104px 104px auto 34px;gap:8px;align-items:center}
.mhead{padding:0 9px 8px;font-size:12px;font-weight:600;color:var(--muted);letter-spacing:.02em}
.mhead span{white-space:nowrap}
.mrows{display:flex;flex-direction:column;gap:8px}
.tip{display:inline-grid;place-items:center;width:15px;height:15px;margin-left:3px;border-radius:50%;border:1px solid var(--line-2);font:600 10px/1 sans-serif;font-style:normal;color:var(--muted);cursor:help;vertical-align:1px}
.tip:hover{color:var(--accent);border-color:var(--accent)}
.mnote{margin-top:12px;padding:10px 12px;border-radius:9px;background:var(--surface-2);border:1px dashed var(--line-2);font-size:12px;line-height:1.7;color:var(--fg-2)}
.mnote b{color:var(--fg);font-weight:600}
.mnote code{font-family:var(--mono);font-size:11.5px;padding:0 4px;border-radius:4px;background:var(--surface);border:1px solid var(--line)}
.mrow{padding:8px;border:1px solid var(--line);border-radius:10px;background:var(--surface-2)}
.mrow .input{height:34px;background:var(--surface)}
.caps{display:flex;gap:6px}
.pill{position:relative;cursor:pointer;user-select:none}
.pill input{position:absolute;opacity:0;pointer-events:none}
.pill span{display:inline-flex;align-items:center;height:30px;padding:0 11px;border-radius:999px;border:1px solid var(--line-2);font-size:12px;font-weight:550;color:var(--muted);background:var(--surface);white-space:nowrap;transition:all .15s}
.pill:hover span{color:var(--fg-2)}
.pill input:checked+span{background:var(--accent-soft);border-color:var(--accent);color:var(--accent)}
.pill input:focus-visible+span{box-shadow:0 0 0 3px var(--accent-soft)}
.icon-btn{width:34px;height:34px;border-radius:8px;border:none;background:none;color:var(--muted);cursor:pointer;display:grid;place-items:center;font-size:16px}
.icon-btn:hover{background:var(--danger-soft);color:var(--danger)}
@media (max-width:760px){
  .mhead{display:none}
  .mgrid{grid-template-columns:1fr 1fr 34px}
  .mgrid .c-id{grid-column:1/3}.mgrid .c-del{grid-column:3;grid-row:1}
  .mgrid .c-name{grid-column:1/-1}
  .mgrid .c-caps{grid-column:1/-1}
}

/* fetched */
.fetch{margin-bottom:14px;border:1px solid var(--line);border-radius:10px;background:var(--surface-2);padding:12px;display:none}
.fetch.show{display:block}
.fetch-h{display:flex;align-items:center;gap:10px;margin-bottom:10px;flex-wrap:wrap}
.fetch-h .input{height:32px;max-width:240px;flex:1;min-width:140px}
.fetch-h .count{font-size:13px;color:var(--fg-2)}
.fetch-h .sp{flex:1}
.chips{display:flex;flex-wrap:wrap;gap:6px;max-height:200px;overflow:auto}
.chip{height:28px;padding:0 10px;border-radius:999px;border:1px solid var(--line-2);background:var(--surface);font:12px var(--mono);cursor:pointer;display:inline-flex;align-items:center;gap:5px}
.chip:hover{border-color:var(--muted)}
.chip.on{background:var(--accent);border-color:var(--accent);color:var(--accent-fg)}
.chip.on::before{content:"✓";font-family:inherit}

/* footer bar */
.bar{position:sticky;bottom:0;display:flex;align-items:center;gap:10px;padding:14px 24px;border-top:1px solid var(--line);background:color-mix(in srgb,var(--surface) 92%,transparent);backdrop-filter:blur(8px)}
.bar .sp{flex:1}
.dirty{display:none;align-items:center;gap:6px;font-size:13px;color:var(--fg-2)}
.dirty.show{display:inline-flex}
.dirty::before{content:"";width:7px;height:7px;border-radius:50%;background:#e0a100}
kbd{font:11px var(--mono);padding:1px 5px;border-radius:4px;border:1px solid var(--line-2);color:var(--muted)}

/* toast */
.toasts{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);display:flex;flex-direction:column;gap:8px;z-index:10;width:max-content;max-width:calc(100vw - 32px)}
.toast{padding:10px 14px;border-radius:10px;background:var(--fg);color:var(--bg);font-size:13px;box-shadow:0 8px 24px rgba(0,0,0,.18);display:flex;gap:8px;align-items:flex-start;animation:tin .18s ease-out}
.toast.err{background:var(--danger);color:#fff}
.toast i{font-style:normal;font-weight:700}
@keyframes tin{from{opacity:0;transform:translateY(6px)}}

/* closed */
.done{max-width:420px;margin:18vh auto;text-align:center;padding:36px 28px}
.done .logo{margin:0 auto 16px;width:48px;height:48px;font-size:22px;border-radius:14px}
.done h1{font-size:18px;margin:0 0 6px}
.done p{color:var(--fg-2);margin:0}
.done code{font-family:var(--mono);background:var(--surface-2);border:1px solid var(--line);padding:1px 6px;border-radius:5px}
</style>
</head>
<body>
<div class="app" id="app">
  <header class="top">
    <div class="logo">π</div>
    <div>
      <h1>模型 API 配置</h1>
      <div class="path" id="path">加载中…</div>
    </div>
    <div class="sp"></div>
    <div class="theme" id="theme" role="radiogroup" aria-label="主题">
      <button type="button" data-t="system" title="跟随系统" aria-label="跟随系统"><svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/></svg></button>
      <button type="button" data-t="light" title="浅色" aria-label="浅色"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg></button>
      <button type="button" data-t="dark" title="深色" aria-label="深色"><svg viewBox="0 0 24 24"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg></button>
    </div>
    <button class="btn ghost" id="closeBtn">完成并关闭</button>
  </header>

  <div class="layout">
    <aside class="panel side">
      <div class="side-h"><span class="eyebrow">PROVIDERS</span><span class="badge" id="pcount">0</span></div>
      <div class="plist" id="plist"></div>
      <div style="margin-top:10px"><button class="btn sm block" id="newBtn">＋ 新建 Provider</button></div>
    </aside>

    <main class="panel main">
      <section class="sec">
        <div class="sec-h">
          <div class="title-row"><h2 id="formTitle">新建 Provider</h2><span class="badge" id="modeBadge">新建</span></div>
        </div>
        <div class="fields">
          <div class="field">
            <label for="provider">Provider 名称</label>
            <input class="input" id="provider" placeholder="my-proxy" autocomplete="off" spellcheck="false">
            <div class="hint">在 /model 中显示为 provider/model</div>
          </div>
          <div class="field">
            <label for="baseUrl">Base URL</label>
            <input class="input mono" id="baseUrl" placeholder="https://api.example.com/v1" autocomplete="off" spellcheck="false">
            <div class="hint">通常以 /v1 结尾</div>
          </div>
          <div class="field full">
            <span class="flabel">接口协议</span>
            <div class="seg" id="apiSeg"></div>
          </div>
          <div class="field full">
            <label for="apiKey">API Key</label>
            <div class="with-btn">
              <input class="input mono" id="apiKey" type="password" autocomplete="off" spellcheck="false">
              <button class="in-btn" id="eyeBtn" type="button">显示</button>
            </div>
            <div class="hint">也可填写 <code>$ENV_NAME</code> 引用环境变量，避免明文保存</div>
          </div>
        </div>
      </section>

      <section class="sec">
        <div class="sec-h">
          <h2>模型</h2><span class="badge" id="mcount">0</span>
          <div class="sp"></div>
          <button class="btn sm" id="fetchBtn"><span class="spin"></span>从接口获取</button>
          <button class="btn sm" id="addRowBtn">＋ 添加</button>
        </div>

        <div class="fetch" id="fetch">
          <div class="fetch-h">
            <span class="count" id="fcount"></span>
            <input class="input" id="ffilter" placeholder="筛选模型…" autocomplete="off">
            <div class="sp"></div>
            <button class="btn ghost sm" id="fhide">收起</button>
          </div>
          <div class="chips" id="chips"></div>
        </div>

        <div class="mgrid mhead"><span>模型 ID</span><span>显示名</span>
          <span>上下文 <i class="tip" title="上下文窗口：模型单次请求能容纳的最大 token 数（系统提示 + 历史 + 本轮输入）。pi 用它判断何时压缩对话。">?</i></span>
          <span>最大输出 <i class="tip" title="单次回复最多生成的 token 数，超过服务商上限会报错。">?</i></span>
          <span>能力</span><span></span></div>
        <div class="mrows" id="rows"></div>
        <div class="mnote">
          <div><b>上下文</b>：模型一次能接收的最大 token 数（含系统提示与历史对话），pi 据此决定何时自动压缩。默认 <code>128k</code>。</div>
          <div><b>最大输出</b>：单次回复最多生成的 token 数，填太大可能被服务商拒绝。默认 <code>16k</code>。</div>
          <div>支持 <code>128k</code>、<code>1M</code> 这样的写法；不确定时保持默认即可，具体数值以服务商文档为准。清空则使用 pi 内置默认值。</div>
        </div>
      </section>

      <div class="bar">
        <button class="btn danger" id="delBtn" style="display:none">删除</button>
        <div class="sp"></div>
        <span class="dirty" id="dirty">未保存</span>
        <button class="btn primary" id="saveBtn"><span class="spin"></span>保存 <kbd style="border-color:transparent;color:inherit;opacity:.7">Ctrl S</kbd></button>
      </div>
    </main>
  </div>
</div>
<div class="toasts" id="toasts"></div>

<script>
const KEEP_KEY = "__KEEP_KEY__";
const APIS = __APIS__;
const API_LABELS = {
  "openai-completions": "OpenAI 兼容",
  "openai-responses": "OpenAI Responses",
  "anthropic-messages": "Anthropic",
  "google-generative-ai": "Gemini"
};
const DEFAULT_CTX = 128000, DEFAULT_MAX = 16000;
const base = location.pathname.replace(/\/$/, "");
const $ = (id) => document.getElementById(id);
let providers = [], editing = null, fetchedIds = [], apiValue = APIS[0], dirty = false;

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const k in attrs || {}) {
    if (k === "class") el.className = attrs[k];
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), attrs[k]);
    else el.setAttribute(k, attrs[k]);
  }
  for (const c of kids) if (c != null) el.append(c);
  return el;
}

function toast(text, kind) {
  const t = h("div", { class: "toast " + (kind || "") }, h("i", {}, kind === "err" ? "!" : "✓"), h("span", {}, text));
  $("toasts").append(t);
  setTimeout(() => t.remove(), kind === "err" ? 6000 : 3200);
}

function setDirty(v) { dirty = v; $("dirty").classList.toggle("show", v); }
function busy(btn, v) { btn.disabled = v; btn.classList.toggle("loading", v); }

async function call(path, body) {
  const res = await fetch(base + path, body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || ("HTTP " + res.status));
  return data;
}

/* ---------- api segmented ---------- */
function renderApis() {
  const seg = $("apiSeg"); seg.innerHTML = "";
  const list = APIS.includes(apiValue) ? APIS : APIS.concat(apiValue);
  seg.style.gridTemplateColumns = window.innerWidth > 620 ? "repeat(" + list.length + ",1fr)" : "";
  for (const a of list) {
    seg.append(h("button", { type: "button", class: a === apiValue ? "on" : "", title: a, onclick: () => { apiValue = a; renderApis(); setDirty(true); } },
      h("b", {}, API_LABELS[a] || "自定义"), h("small", {}, a)));
  }
}

/* ---------- model rows ---------- */
function parseNum(v) {
  const m = /^\s*([\d.]+)\s*([kKmM]?)\s*$/.exec(v || "");
  if (!m) return v ? NaN : "";
  const n = parseFloat(m[1]) * (/k/i.test(m[2]) ? 1000 : /m/i.test(m[2]) ? 1000000 : 1);
  return Math.round(n);
}
function fmtNum(n) {
  if (!n) return "";
  if (n % 1000000 === 0) return n / 1000000 + "M";
  if (n % 1000 === 0) return n / 1000 + "k";
  return String(n);
}

function pill(key, label, checked) {
  const cb = h("input", { type: "checkbox", "data-k": key });
  cb.checked = !!checked;
  return h("label", { class: "pill" }, cb, h("span", {}, label));
}

function addRow(m, focus) {
  m = m || {};
  const id = h("input", { class: "input mono", "data-k": "id", placeholder: "model-id", spellcheck: "false", autocomplete: "off" });
  const name = h("input", { class: "input", "data-k": "name", placeholder: "可选" });
  const ctx = h("input", { class: "input mono", "data-k": "contextWindow", placeholder: "128k", inputmode: "numeric" });
  const max = h("input", { class: "input mono", "data-k": "maxTokens", placeholder: "16k", inputmode: "numeric" });
  id.value = m.id || ""; name.value = m.name || "";
  ctx.value = fmtNum(m.contextWindow || DEFAULT_CTX); max.value = fmtNum(m.maxTokens || DEFAULT_MAX);
  ctx.title = "上下文窗口（token），如 128k、200k、1M";
  max.title = "单次最大输出（token），如 8k、16k、32k";
  const row = h("div", { class: "mrow mgrid" },
    h("div", { class: "c-id" }, id),
    h("div", { class: "c-name" }, name),
    h("div", {}, ctx), h("div", {}, max),
    h("div", { class: "caps c-caps" }, pill("reasoning", "推理", m.reasoning), pill("image", "图片", m.image)),
    h("div", { class: "c-del" }, h("button", { class: "icon-btn", type: "button", title: "移除", onclick: () => { row.remove(); afterRowsChange(); setDirty(true); } }, "✕")));
  for (const inp of [ctx, max]) inp.addEventListener("input", () => inp.classList.toggle("invalid", Number.isNaN(parseNum(inp.value))));
  id.addEventListener("input", () => { id.classList.remove("invalid"); renderChips(); });
  $("rows").append(row);
  afterRowsChange();
  if (focus) id.focus();
}

function afterRowsChange() { $("mcount").textContent = rowIds().length; renderChips(); }
function rowIds() { return [...$("rows").querySelectorAll('[data-k="id"]')].map((e) => e.value.trim()).filter(Boolean); }

function readRows() {
  return [...$("rows").children].map((row) => {
    const m = {};
    for (const el of row.querySelectorAll("[data-k]")) m[el.dataset.k] = el.type === "checkbox" ? el.checked : el.value.trim();
    m.contextWindow = parseNum(m.contextWindow) || "";
    m.maxTokens = parseNum(m.maxTokens) || "";
    return m;
  }).filter((m) => m.id);
}

/* ---------- fetched chips ---------- */
function renderChips() {
  const box = $("chips"); box.innerHTML = "";
  const have = new Set(rowIds());
  const q = $("ffilter").value.trim().toLowerCase();
  const shown = fetchedIds.filter((id) => !q || id.toLowerCase().includes(q));
  for (const id of shown) {
    box.append(h("button", { type: "button", class: "chip" + (have.has(id) ? " on" : ""), onclick: () => toggleFetched(id, have.has(id)) }, id));
  }
  $("fcount").textContent = "接口返回 " + fetchedIds.length + " 个模型 · 已选 " + fetchedIds.filter((id) => have.has(id)).length;
}

function toggleFetched(id, on) {
  if (on) { for (const row of [...$("rows").children]) if (row.querySelector('[data-k="id"]').value.trim() === id) row.remove(); }
  else {
    const empty = [...$("rows").children].find((row) => !row.querySelector('[data-k="id"]').value.trim());
    if (empty) empty.remove();
    addRow({ id });
  }
  afterRowsChange(); setDirty(true);
}

/* ---------- sidebar & form ---------- */
function renderSidebar() {
  const list = $("plist"); list.innerHTML = "";
  $("pcount").textContent = providers.length;
  if (!providers.length) list.append(h("div", { class: "empty" }, "还没有自定义 Provider"));
  for (const p of providers) {
    list.append(h("button", { type: "button", class: "pitem" + (p.name === editing ? " active" : ""), onclick: () => confirmLeave() && fillForm(p) },
      h("div", { class: "pav" }, p.name.slice(0, 1)),
      h("div", { class: "pbody" },
        h("div", { class: "pname" }, p.name),
        h("div", { class: "psub" }, p.models.length + " 个模型 · " + (API_LABELS[p.api] || p.api || "未设置")))));
  }
}

function fillForm(p) {
  editing = p ? p.name : null;
  $("formTitle").textContent = p ? p.name : "新建 Provider";
  $("modeBadge").textContent = p ? "编辑" : "新建";
  $("provider").value = p ? p.name : "";
  apiValue = p && p.api ? p.api : APIS[0];
  renderApis();
  $("baseUrl").value = p ? p.baseUrl : "";
  $("apiKey").value = "";
  $("apiKey").type = "password"; $("eyeBtn").textContent = "显示";
  $("apiKey").placeholder = p && p.hasKey ? "已保存 " + p.apiKeyMasked + "，留空则不修改" : "sk-...";
  $("delBtn").style.display = p ? "" : "none";
  $("rows").innerHTML = "";
  fetchedIds = []; $("ffilter").value = ""; $("fetch").classList.remove("show");
  (p && p.models.length ? p.models : [{}]).forEach((m) => addRow(m));
  for (const el of document.querySelectorAll(".invalid")) el.classList.remove("invalid");
  renderSidebar();
  setDirty(false);
}

function confirmLeave() { return !dirty || confirm("当前修改尚未保存，确定放弃？"); }

async function load(selectName) {
  const data = await call("/api/providers");
  $("path").textContent = data.path;
  providers = data.providers;
  fillForm(providers.find((p) => p.name === selectName) || (selectName === undefined ? providers[0] : null) || null);
}

function keyValue() { const k = $("apiKey").value.trim(); return !k && editing ? KEEP_KEY : k; }

function validate() {
  let ok = true;
  const mark = (el, bad) => { el.classList.toggle("invalid", bad); if (bad && ok) { el.focus(); ok = false; } };
  mark($("provider"), !/^[A-Za-z0-9._-]+$/.test($("provider").value.trim()));
  mark($("baseUrl"), !/^https?:\/\//i.test($("baseUrl").value.trim()));
  mark($("apiKey"), !keyValue());
  const ids = [...$("rows").querySelectorAll('[data-k="id"]')];
  if (!ids.some((e) => e.value.trim())) mark(ids[0] || $("addRowBtn"), true);
  for (const el of $("rows").querySelectorAll('[data-k="contextWindow"],[data-k="maxTokens"]')) mark(el, Number.isNaN(parseNum(el.value)));
  return ok;
}

/* ---------- actions ---------- */
async function save() {
  if (!validate()) { toast("请检查标红的字段", "err"); return; }
  const btn = $("saveBtn"); busy(btn, true);
  try {
    const r = await call("/api/save", { provider: $("provider").value, originalProvider: editing, baseUrl: $("baseUrl").value, api: apiValue, apiKey: keyValue(), models: readRows() });
    setDirty(false);
    await load(r.provider);
    toast("已保存 " + r.provider + " · " + r.models.length + " 个模型，回到终端 /model 即可选择");
  } catch (e) { toast("保存失败：" + e.message, "err"); }
  finally { busy(btn, false); }
}

$("saveBtn").onclick = save;
document.addEventListener("keydown", (e) => { if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); save(); } });
document.addEventListener("input", (e) => { if (e.target.closest && e.target.closest(".main") && e.target.id !== "ffilter") setDirty(true); });
document.addEventListener("change", (e) => { if (e.target.type === "checkbox") setDirty(true); });

$("newBtn").onclick = () => { if (confirmLeave()) { fillForm(null); $("provider").focus(); } };
$("addRowBtn").onclick = () => { addRow({}, true); setDirty(true); };
$("eyeBtn").onclick = () => { const k = $("apiKey"); const show = k.type === "password"; k.type = show ? "text" : "password"; $("eyeBtn").textContent = show ? "隐藏" : "显示"; };
$("ffilter").oninput = renderChips;
$("fhide").onclick = () => $("fetch").classList.remove("show");
window.addEventListener("resize", renderApis);

$("fetchBtn").onclick = async () => {
  if (!/^https?:\/\//i.test($("baseUrl").value.trim())) { $("baseUrl").classList.add("invalid"); $("baseUrl").focus(); toast("请先填写 Base URL", "err"); return; }
  const btn = $("fetchBtn"); busy(btn, true);
  try {
    const { ids } = await call("/api/fetch-models", { baseUrl: $("baseUrl").value, api: apiValue, apiKey: keyValue(), provider: editing });
    fetchedIds = ids;
    $("fetch").classList.add("show"); renderChips();
    if (ids.length) toast("获取到 " + ids.length + " 个模型，点击即可添加"); else toast("接口没有返回模型", "err");
  } catch (e) { toast("获取失败：" + e.message + "，可手动填写模型 ID", "err"); }
  finally { busy(btn, false); }
};

$("delBtn").onclick = async () => {
  if (!editing || !confirm("确定删除 Provider「" + editing + "」及其所有模型？")) return;
  try { const name = editing; setDirty(false); await call("/api/delete", { name }); await load(null); toast("已删除 " + name); }
  catch (e) { toast("删除失败：" + e.message, "err"); }
};

$("closeBtn").onclick = async () => {
  if (!confirmLeave()) return;
  try { await call("/api/close", {}); } catch {}
  document.body.innerHTML = '<div class="panel done"><div class="logo">π</div><h1>配置已完成</h1><p>可以关闭此标签页，回到终端输入 <code>/model</code> 选择模型。</p></div>';
};

/* ---------- theme ---------- */
function applyTheme(t) {
  if (t === "light" || t === "dark") document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
  for (const b of $("theme").children) { b.classList.toggle("on", b.dataset.t === t); b.setAttribute("aria-checked", b.dataset.t === t); }
  try { if (t === "system") localStorage.removeItem("pi-apiconfig-theme"); else localStorage.setItem("pi-apiconfig-theme", t); } catch {}
}
for (const b of $("theme").children) b.onclick = () => applyTheme(b.dataset.t);
applyTheme(document.documentElement.dataset.theme || "system");

renderApis();
load().catch((e) => { $("path").textContent = "加载失败"; toast("加载失败：" + e.message, "err"); });
</script>
</body>
</html>`;
