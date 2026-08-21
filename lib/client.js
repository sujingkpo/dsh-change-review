/*
 * @description DeepSeek Harness 会话修改审查插件客户端 UI：会话「审查」标签页、
 *             轮次内变更卡片、输入框上方实时变更面板（LivePanel）、颜色自定义、编辑器选择器、上下文菜单。
 * @author chenzhenyao / cirelir
 * @date 2026-08-21
 * @modify 2026-08-21 输入框上方「变更（实时）」面板宽度对齐聊天输入框：
 *                    .dsdrv-livepanel-card 的 max-width 直接取 var(--dsh-composer-card-max-width)（780px），
 *                    与聊天输入框（composer 卡片）同宽，宽屏下 780px 居中。
 * @modify 2026-08-21 面板头部右侧折叠/展开按钮箭头方向对调：展开时显示向下箭头 ∨、
 *                    折叠时显示向上箭头 ∧（箭头表示面板当前展开状态，而非点击动作）。
 * @modify 2026-08-21 .dsdrv-livepanel 宽度改为 calc(100% - 2×side-clearance - 4px)：
 *                    在侧边距基础上再减 4px，微调对齐避免面板比聊天输入框更宽。
 */
window.__ModuleLoader__.load({
	id: "dsh-change-review",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const React = require("react");

		// ── color configuration (persisted to localStorage) ────────────────
		const LS_KEY = "dsh.diff-review.colors";
		const LIGHT = { addBg: "#e6ffec", addFg: "#1a7f37", delBg: "#ffebe9", delFg: "#cf222e", ctxBg: "#f6f8fa", gutter: "#57606a", badgeBg: "#0969da", badgeFg: "#ffffff", turnAdd: "#1a7f37", turnDel: "#cf222e", turnBg: "rgba(255, 183, 77, 0.1)", turnBorder: "#ffb74d" };
		const DARK = { addBg: "#10251c", addFg: "#7ee787", delBg: "#2d1415", delFg: "#ffa198", ctxBg: "#161b22", gutter: "#8b949e", badgeBg: "#4493f8", badgeFg: "#0d1117", turnAdd: "#7ee787", turnDel: "#ffa198", turnBg: "rgba(255, 183, 77, 0.1)", turnBorder: "#ffb74d" };
		const DEFAULTS = Object.assign({}, LIGHT);
		const COLOR_KEYS = Object.keys(DEFAULTS);

		function loadSavedColors() {
			try {
				const raw = localStorage.getItem(LS_KEY);
				if (!raw) return null;
				const obj = JSON.parse(raw);
				if (!obj || typeof obj !== "object") return null;
				const out = Object.assign({}, DEFAULTS);
				let ok = false;
				for (const k of COLOR_KEYS) {
					const parsed = parseColor(obj[k]);
					if (parsed) {
						out[k] = formatRgba(parsed);
						ok = true;
					}
				}
				return ok ? out : null;
			} catch (e) {
				return null;
			}
		}
		function saveColors(colors) {
			try {
				localStorage.setItem(LS_KEY, JSON.stringify(colors));
			} catch (e) {}
		}

		// ── color value helpers (hex #rrggbb and rgba(r,g,b,a) both supported) ──
		function parseColor(v) {
			if (typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v)) {
				return { r: parseInt(v.slice(1, 3), 16), g: parseInt(v.slice(3, 5), 16), b: parseInt(v.slice(5, 7), 16), a: 1 };
			}
			if (typeof v === "string") {
				const m = v.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+)\s*)?\)$/);
				if (m) {
					const a = m[4] === undefined ? 1 : Number(m[4]);
					return {
						r: Math.min(255, Math.max(0, parseInt(m[1], 10))),
						g: Math.min(255, Math.max(0, parseInt(m[2], 10))),
						b: Math.min(255, Math.max(0, parseInt(m[3], 10))),
						a: Math.min(1, Math.max(0, a))
					};
				}
			}
			return null;
		}
		function formatRgba(c) {
			return "rgba(" + c.r + ", " + c.g + ", " + c.b + ", " + (Math.round(c.a * 100) / 100) + ")";
		}
		function hexOf(c) {
			const pad = (n) => n.toString(16).padStart(2, "0");
			return "#" + pad(c.r) + pad(c.g) + pad(c.b);
		}

		// ── shared store ───────────────────────────────────────────────────
		const EDITOR_LS_KEY = "dsh.diff-review.editor";
		const store = {
			files: null, loadingFiles: false,
			selected: null, detail: null, loadingDetail: false, error: null,
			colors: Object.assign({}, DEFAULTS), currentSession: null,
			mode: "session", latestTurn: 0, turnData: null,
			editors: [], editorLoading: false, selectedEditor: null,
			// 当前 DSH 外观（light/dark），用于让颜色随主题切换
			scheme: "light",
			// 每次 SSE 数据刷新 +1：驱动轮次卡片等组件在对话过程中实时重拉数据
			reviewTick: 0,
			// 自定义确认弹窗的待办项：{ message, resolve }，见 askConfirm/ConfirmPrompt
			pendingConfirm: null
		};
		// 是否持久化过用户自定义颜色（存在旧存档时视为已自定义）
		let hasSavedColors = false;
		{
			const savedColors = loadSavedColors();
			if (savedColors) { store.colors = savedColors; hasSavedColors = true; }
			try {
				const ed = localStorage.getItem(EDITOR_LS_KEY);
				if (ed) store.selectedEditor = JSON.parse(ed);
			} catch (e) {}
		}
		const listeners = new Set();
		function notify() { listeners.forEach((fn) => fn()); }
		// ── theme-driven palette：颜色随宿主外观（浅色/深色）走 ──────────────
		function paletteFor(scheme) { return scheme === "dark" ? DARK : LIGHT; }
		// 仅更新颜色并通知视图，不写入 localStorage：
		// 外观驱动的默认色不应被持久化，否则下次以其它外观启动时会读到与当前外观不符的旧色。
		function setColorsQuiet(colors) { store.colors = colors; notify(); }
		function setState(patch) {
			Object.assign(store, patch);
			if (patch.colors) saveColors(patch.colors);
			notify();
		}
		function useStore(selector) {
			const [v, setV] = React.useState(() => selector(store));
			React.useEffect(() => {
				const fn = () => setV(selector(store));
				listeners.add(fn);
				return () => listeners.delete(fn);
			}, []);
			return v;
		}

		// ── 自定义确认弹窗：不用原生 window.confirm ────────────────────────
		// DSH 的 WebView 里原生 confirm 是同步浏览器模态，关闭后容易把富文本
		// 输入框的 focus/IME 状态弄坏（表现为撤回后输入框一直无法输入，刷新才
		// 恢复）。这里改用页面内的非阻塞确认，避免触发浏览器原生模态。
		function askConfirm(message) {
			return new Promise((resolve) => {
				store.pendingConfirm = { message, resolve };
				notify();
			});
		}
		function ConfirmPrompt() {
			const pending = useStore((s) => s.pendingConfirm);
			if (!pending) return null;
			const dismiss = (okValue) => {
				const p = store.pendingConfirm;
				if (!p) return;
				store.pendingConfirm = null;
				notify();
				if (typeof p.resolve === "function") p.resolve(okValue);
			};
			return React.createElement("div", {
				className: "dsdrv-modal-mask",
				onMouseDown: (e) => { e.stopPropagation(); }
			},
				React.createElement("div", { className: "dsdrv-modal", role: "dialog", "aria-modal": true },
					React.createElement("div", { className: "dsdrv-modal-text" }, pending.message),
					React.createElement("div", { className: "dsdrv-modal-btns" },
						React.createElement("button", { type: "button", className: "drv-btn", onClick: () => dismiss(false) }, "取消"),
						React.createElement("button", { type: "button", className: "drv-btn drv-btn-danger", onClick: () => dismiss(true) }, "确定"))));
		}

		// ── fetch sequencing: every async load stamps a token; a stale response
		// (previous session / superseded file) is dropped instead of clobbering the UI
		let reqSeq = 0

		// ── host file-open helper (chat's openFile equivalent, built from ctx).
		// If the user picked an editor in the header chooser, open through the
		// Host's /diff-review/open-with-editor route; otherwise OS default.
		let ctxRef = null
		let rtApi = null
		try { rtApi = require("@deepseek-ai/dsh-client-runtime/client"); } catch (e) { rtApi = null; }
		function resolveAbsPath(sessionId, path, cwd) {
			try {
				if (!ctxRef) return path
				// Use the provided cwd (from file data) first, then fall back to session's current cwd
				if (!cwd && ctxRef.sessions && ctxRef.sessions.list) {
					const byId = ctxRef.sessions.list.getSnapshot().byId
					cwd = byId && byId[sessionId] && byId[sessionId].cwd
				}
				if (rtApi && rtApi.resolveWorkspacePath) return rtApi.resolveWorkspacePath(cwd, path)
				if (cwd && typeof path === "string" && !path.startsWith("/") && !/^[a-zA-Z]:[\/]/.test(path)) {
					return cwd.replace(/[\/]+$/, "") + "/" + path.replace(/^[\/]+/, "")
				}
				return path
			} catch (e) { return path }
		}
		function openFileFor(sessionId, path, cwd) {
			try {
				if (!ctxRef) return
				const abs = resolveAbsPath(sessionId, path, cwd)
				const ed = store.selectedEditor
				if (ed && ed.id) {
					apiOpenWithEditor(ed.id, abs).then((v) => {
						if (!(v && v.ok)) openViaWorkspace(abs)
					}).catch(() => openViaWorkspace(abs))
					return
				}
				openViaWorkspace(abs)
			} catch (e) {}
		}
		function openViaWorkspace(abs) {
			try {
				if (ctxRef && ctxRef.workspaces && ctxRef.workspaces.openPath && abs) {
					ctxRef.workspaces.openPath(abs).catch(() => {})
				}
			} catch (e) {}
		}

		// ── host data via HTTP routes ──────────────────────────────────────
		function apiSummary(session) { return fetch("/diff-review/summary?session=" + encodeURIComponent(session)).then((r) => r.json()); }
		function apiFile(session, path) { return fetch("/diff-review/file?session=" + encodeURIComponent(session) + "&path=" + encodeURIComponent(path)).then((r) => r.json()); }
		function apiClear(session) { return fetch("/diff-review/clear?session=" + encodeURIComponent(session), { method: "POST" }).then((r) => r.json()); }
		function apiRevert(session, path, op) {
			return fetch("/diff-review/revert?session=" + encodeURIComponent(session), {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ path: path, op: op === undefined ? null : op })
			}).then((r) => r.json());
		}
		function apiTurn(session, turn) {
			return fetch("/diff-review/turn?session=" + encodeURIComponent(session) + "&turn=" + encodeURIComponent(String(turn))).then((r) => r.json());
		}
		function apiEditors() { return fetch("/diff-review/editors").then((r) => r.json()); }
		function apiOpenWithEditor(editor, path, line, col) {
			return fetch("/diff-review/open-with-editor", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ editor, path, line: line || null, col: col || null })
			}).then((r) => r.json());
		}
		function apiReveal(path) {
			return fetch("/diff-review/reveal", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ path })
			}).then((r) => r.json());
		}
		function revealInFinderFor(sessionId, path, cwd) {
			const abs = resolveAbsPath(sessionId, path, cwd);
			apiReveal(abs).catch(() => {});
		}
		function loadEditors() {
			setState({ editorLoading: true });
			apiEditors().then((v) => {
				const editors = (v && v.editors) || [];
				// Never overwrite selectedEditor — it's persisted from localStorage
				// and only changed by the user's explicit selection via selectEditor().
				setState({ editors, editorLoading: false });
			}).catch(() => {
				setState({ editorLoading: false });
			});
		}
		function selectEditor(ed) {
			setState({ selectedEditor: ed });
			try {
				if (ed && ed.id) localStorage.setItem(EDITOR_LS_KEY, JSON.stringify({ id: ed.id, name: ed.name }));
				else localStorage.removeItem(EDITOR_LS_KEY);
			} catch (e) {}
		}

		function loadSummary() {
			const session = store.currentSession;
			if (!session) return;
			const seq = ++reqSeq;
			setState({ loadingFiles: true, error: null });
			apiSummary(session).then((v) => {
				if (seq !== reqSeq || store.currentSession !== session) return;
				setState({ files: (v && v.files) || [], latestTurn: (v && typeof v.latestTurn === "number") ? v.latestTurn : 0, loadingFiles: false, reviewTick: store.reviewTick + 1 });
				if (store.mode === "latest") loadLatest();
			}).catch((e) => {
				if (seq !== reqSeq || store.currentSession !== session) return;
				setState({ error: String((e && e.message) || e), loadingFiles: false });
			});
		}
		// Latest-turn view: files + sections for the most recent recorded turn.
		function loadLatest() {
			const session = store.currentSession;
			const turn = store.latestTurn;
			if (!session || !turn) { setState({ turnData: null }); return; }
			const seq = ++reqSeq;
			apiTurn(session, turn).then((v) => {
				if (seq !== reqSeq || store.currentSession !== session) return;
				setState({ turnData: (v && v.files) ? v : null });
			}).catch(() => {
				if (seq !== reqSeq || store.currentSession !== session) return;
				setState({ turnData: null });
			});
		}
		function setMode(mode) {
			setState({ mode: mode, selected: null, detail: null });
			if (mode === "latest") loadLatest();
		}
		// Select a file: latest mode shows the turn payload's inline sections.
		function selectFile(f) {
			if (store.mode === "latest") {
				setState({
					selected: f.path,
					detail: { path: f.path, sections: (f && f.sections) || [], revertible: !!(f && f.revertible) },
					loadingDetail: false,
					error: null
				});
			} else {
				loadDetail(f.path);
			}
		}
		function loadDetail(path) {
			const session = store.currentSession;
			if (!session) return;
			const seq = ++reqSeq;
			setState({ selected: path, detail: null, loadingDetail: true, error: null });
			apiFile(session, path).then((v) => {
				if (seq !== reqSeq || store.currentSession !== session || store.selected !== path) return;
				setState({ detail: v, loadingDetail: false });
			}).catch((e) => {
				if (seq !== reqSeq || store.currentSession !== session) return;
				setState({ error: String((e && e.message) || e), loadingDetail: false });
			});
		}
		function refresh() {
			loadSummary();
			if (store.mode === "latest") { loadLatest(); return; }
			if (store.selected) loadDetail(store.selected);
		}
		function refreshFromServer() {
			const session = store.currentSession;
			if (!session) return;
			const seq = ++reqSeq;
			apiSummary(session).then((v) => {
				if (seq !== reqSeq || store.currentSession !== session) return;
				const next = (v && v.files) || [];
				const latestTurn = (v && typeof v.latestTurn === "number") ? v.latestTurn : 0;
				const cur = store.files;
				const hadFiles = cur !== null;
				const curList = cur || [];
				let changed = !hadFiles || next.length !== curList.length;
				if (!changed && hadFiles) {
					for (let i = 0; i < next.length; i++) {
						const a = next[i];
						const b = curList[i];
						if (!b || a.path !== b.path || a.lastTime !== b.lastTime || a.ops !== b.ops) { changed = true; break; }
					}
				}
				if (changed || latestTurn !== store.latestTurn) {
					setState({ files: next, latestTurn: latestTurn, loadingFiles: false, reviewTick: store.reviewTick + 1 });
					if (store.mode === "latest") loadLatest();
				} else if (!hadFiles) {
					setState({ files: [], loadingFiles: false });
				}
			}).catch(() => {});
		}

		function connectEvents() {
			const es = new EventSource("/diff-review/events");
			es.onopen = () => {
				// 重连后重新同步，避免重连期间丢失的变更造成角标/列表不一致
				if (store.currentSession) refreshFromServer();
			};
			es.onmessage = (e) => {
				let matches = true;
				try {
					const d = JSON.parse(e.data);
					if (d && d.session) matches = d.session === store.currentSession;
				} catch (err) {}
				if (matches) refreshFromServer();
			};
			es.onerror = () => {
				// EventSource 会自动重连，onopen 时会重新同步
			};
			return () => es.close();
		}

		function fmtTime(t) {
			if (!t) return "";
			const d = new Date(t);
			const p = (x) => String(x).padStart(2, "0");
			return p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
		}

		// ── diff line rendering ────────────────────────────────────────────
		function Line({ h }) {
			const colors = useStore((s) => s.colors);
			let bg;
			let fg;
			let cls;
			if (h.type === "add") { bg = colors.addBg; fg = colors.addFg; cls = "drv-add"; }
			else if (h.type === "del") { bg = colors.delBg; fg = colors.delFg; cls = "drv-del"; }
			else { bg = colors.ctxBg; cls = "drv-ctx-line"; }
			return React.createElement("div", { className: "drv-line " + cls, style: { background: bg, color: fg } },
				React.createElement("span", { className: "drv-gutter", style: { color: colors.gutter } }, h.a != null ? String(h.a) : ""),
				React.createElement("span", { className: "drv-gutter drv-gutter-sign", style: { color: colors.gutter } }, h.type === "add" ? "+" : h.type === "del" ? "−" : " "),
				React.createElement("span", { className: "drv-gutter", style: { color: colors.gutter } }, h.b != null ? String(h.b) : ""),
				React.createElement("span", { className: "drv-text" }, h.text));
		}

		function Section({ section, onRevert, busy }) {
			const kindLabel = section.kind === "edit" ? "编辑" : "写入";
			const cls = section.kind === "edit" ? "drv-badge-edit" : "drv-badge-new";
			return React.createElement("div", { className: "drv-section" },
				React.createElement("div", { className: "drv-section-head" },
					React.createElement("span", { className: "drv-badge " + cls }, kindLabel),
					React.createElement("span", null, section.kind === "edit" ? "修改对比" : "文件内容（完整写入）"),
					React.createElement("span", { className: "drv-section-time" }, fmtTime(section.at)),
					section.truncated ? React.createElement("span", { className: "drv-section-time" }, "（内容过长已截断）") : null,
					React.createElement("span", { className: "drv-header-spacer" }),
					section.canUndo ? React.createElement("button", {
						className: "drv-btn drv-btn-revert",
						title: "撤回该项修改：文件恢复到该项修改之前的内容，其后无冲突的修改保留",
						disabled: busy,
						onClick: () => onRevert(section.opIndex)
					}, "撤回此项") : null),
				React.createElement("div", { className: "drv-section-body" },
					section.hunks.map((h, i) => React.createElement(Line, { key: i, h }))));
		}

		const COLOR_ROWS = [
			["addBg", "新增行背景"], ["addFg", "新增行文字"],
			["delBg", "删除行背景"], ["delFg", "删除行文字"],
			["ctxBg", "上下文背景"], ["gutter", "行号 / 标记"],
			["badgeBg", "角标背景"], ["badgeFg", "角标文字"],
			["turnAdd", "新增行数（对话底部）"], ["turnDel", "删除行数（对话底部）"],
			["turnBg", "背景色（对话底部）"], ["turnBorder", "边框色（对话底部）"]
		];

		function ColorRows() {
			const colors = useStore((s) => s.colors);
			return COLOR_ROWS.map((row) => {
				const key = row[0];
				const parsed = parseColor(colors[key]) || { r: 128, g: 128, b: 128, a: 1 };
				return React.createElement("label", { key: key, className: "drv-color-row" },
					React.createElement("span", null, row[1]),
					React.createElement("div", { className: "drv-color-controls" },
						React.createElement("input", {
							type: "color",
							value: hexOf(parsed),
							onChange: (e) => setState({ colors: Object.assign({}, store.colors, { [key]: formatRgba(Object.assign({}, parsed, parseColor(e.target.value))) }) })
						}),
						React.createElement("input", {
							type: "range",
							min: 0,
							max: 100,
							value: Math.round(parsed.a * 100),
							title: "透明度",
							onChange: (e) => setState({ colors: Object.assign({}, store.colors, { [key]: formatRgba(Object.assign({}, parsed, { a: Number(e.target.value) / 100 })) }) })
						}),
						React.createElement("span", { className: "drv-color-alpha" }, Math.round(parsed.a * 100) + "%"))
				);
			});
		}

		function PresetButtons() {
			return React.createElement("div", { className: "drv-presets" },
				React.createElement("button", { onClick: () => setState({ colors: Object.assign({}, LIGHT) }) }, "浅色预设"),
				React.createElement("button", { onClick: () => setState({ colors: Object.assign({}, DARK) }) }, "深色预设"),
				React.createElement("button", { onClick: () => setState({ colors: Object.assign({}, paletteFor(store.scheme)) }) }, "恢复默认（随外观）"));
		}

		function Detail({ onRevert, onRevertAll, busy }) {
			const selected = useStore((s) => s.selected);
			const detail = useStore((s) => s.detail);
			const loading = useStore((s) => s.loadingDetail);
			const error = useStore((s) => s.error);
			if (loading) return React.createElement("div", { className: "drv-empty" }, "加载中…");
			if (error) return React.createElement("div", { className: "drv-empty" }, "出错：" + error);
			if (!selected) return React.createElement("div", { className: "drv-empty" }, "在左侧选择文件查看修改对比");
			if (!detail || !detail.sections || detail.sections.length === 0) return React.createElement("div", { className: "drv-empty" }, "该文件没有可展示的修改");
			return React.createElement("div", null,
				React.createElement("div", { className: "drv-detail-toolbar" },
					React.createElement("span", { className: "drv-detail-path", title: detail.path }, detail.path),
					React.createElement("span", { className: "drv-header-spacer" }),
					React.createElement("button", {
						className: "drv-btn drv-btn-revert drv-btn-danger",
						title: "撤回该文件的全部修改：恢复到本次会话首次修改之前的内容（会话中新建的文件将被删除）",
						disabled: busy || detail.revertible !== true,
						onClick: onRevertAll
					}, "撤回全部修改")),
				detail.sections.map((sec, i) => React.createElement(Section, { key: i, section: sec, onRevert: onRevert, busy: busy })));
		}

		// ── directory tree grouping for the review-pane file list ──────────────────
		// ── context menu (right-click on file rows) ──────────────────────────────
		function CtxMenu({ menu, onClose }) {
			const rootRef = React.useRef(null);
			React.useEffect(() => {
				if (!menu) return;
				const close = () => onClose();
				// 捕获阶段监听任意“按下”：点击菜单外部即关闭，避免菜单残留成一个
				// position:fixed + z-index 20000 的悬浮色块盖住其它 UI（点击菜单内部则不关）
				const onPointer = (e) => {
					const t = e.target;
					if (rootRef.current && t && rootRef.current.contains(t)) return;
					onClose();
				};
				const handleKey = (e) => { if (e.key === "Escape") onClose(); };
				window.addEventListener("pointerdown", onPointer, true);
				window.addEventListener("blur", close);
				window.addEventListener("scroll", close, true);
				window.addEventListener("keydown", handleKey);
				return () => {
					window.removeEventListener("pointerdown", onPointer, true);
					window.removeEventListener("blur", close);
					window.removeEventListener("scroll", close, true);
					window.removeEventListener("keydown", handleKey);
				};
			}, [!!menu, onClose]);
			if (!menu) return null;
			const items = menu.items || [];
			if (items.length === 0) return null;
			return React.createElement("div", {
				ref: rootRef,
				className: "dsdrv-ctx",
				style: { left: Math.min(menu.x, window.innerWidth - 150), top: Math.min(menu.y, window.innerHeight - 80) },
				onClick: (e) => e.stopPropagation()
			}, items.map((it, i) =>
				React.createElement("button", { key: i, className: "dsdrv-ctx-item", onClick: () => { it.run(); onClose(); } }, it.label)));
		}

		function FileList({ openFile }) {
			const mode = useStore((s) => s.mode);
			const files = useStore((s) => s.files);
			const turnData = useStore((s) => s.turnData);
			const selected = useStore((s) => s.selected);
			const loading = useStore((s) => s.loadingFiles);
			const list = mode === "latest" ? (turnData && turnData.files) || [] : (files || []);
			const [menu, setMenu] = React.useState(null);
			if (loading) return React.createElement("div", { className: "drv-empty" }, "加载中…");
			if (!list || list.length === 0) {
				return React.createElement("div", { className: "drv-empty" },
					mode === "latest"
						? "最新一轮没有可展示的修改（该轮无写入/编辑，或记录没有轮次标记）"
						: "暂无修改记录（进程内通过写入/编辑工具产生的文件修改会出现在这里）");
			}
			const fileRow = (f) => {
				const cls = "drv-file" + (f.path === selected ? " drv-selected" : "");
				return React.createElement("button", {
					key: f.path || f.name, className: cls,
					onClick: () => selectFile(f),
					onContextMenu: (e) => {
						e.preventDefault(); e.stopPropagation();
						setMenu({ x: e.clientX, y: e.clientY, items: [
							{ label: "打开文件", run: () => { if (openFile) openFile(f.path, f.cwd); } },
							{ label: "在 Finder 中展示", run: () => { const sid = store.currentSession; if (sid) revealInFinderFor(sid, f.path, f.cwd); } }
						]});
					}
				},
					React.createElement("span", { className: "drv-file-name" }, f.name),
					React.createElement("span", { className: "drv-file-meta" },
						(f.writes > 0 ? "写入×" + f.writes + " " : "") + (f.edits > 0 ? "编辑×" + f.edits : ""),
						"  ~+" + f.added + " ~−" + f.removed));
			};
			return React.createElement("div", null,
				list.map(fileRow),
				React.createElement(CtxMenu, { menu, onClose: () => setMenu(null) }));
		}

		function SessionProbe(props) {
			React.useEffect(() => {
				if (props.sessionId && store.currentSession !== props.sessionId) {
					reqSeq++; // 丢弃上一个会话仍在途的请求
					setState({ currentSession: props.sessionId, files: null, selected: null, detail: null, mode: "session", turnData: null, latestTurn: 0, error: null, loadingFiles: true });
					refreshFromServer();
				}
			}, [props.sessionId]);
			return null;
		}

		// ── 最大化查看：点开文件后在 detail 工具栏通过「最大化查看」弹出的全屏
		// diff 大窗口。独立拉取 /diff-review/file 数据，支持撤回全部与逐项撤回，
		// 点遮罩层空白处或「关闭」退出。
		function MaximizeDialog({ path, onClose, onRevert, onRevertAll }) {
			const session = useStore((s) => s.currentSession);
			const [data, setData] = React.useState(null);
			const refresh = () => {
				if (!session || !path) return;
				apiFile(session, path).then((v) => { setData(v); }).catch(() => {});
			};
			React.useEffect(() => {
				setData(null);
				refresh();
			}, [session, path]);
			// 撤回（全部或单项）完成后重新拉取本窗口数据，保持 diff 最新
			const revertAllHere = async () => {
				if (typeof onRevertAll === "function") await onRevertAll(path);
				refresh();
			};
			const revertOne = async (opIndex) => {
				if (typeof onRevert === "function") await onRevert(path, opIndex);
				refresh();
			};
			return React.createElement("div", { className: "dsdrv-max-mask", onMouseDown: (e) => { if (e.target === e.currentTarget) onClose(); } },
				React.createElement("div", { className: "dsdrv-max", role: "dialog", "aria-modal": true },
					React.createElement("div", { className: "dsdrv-max-head" },
						React.createElement("span", { className: "drv-detail-path", title: path }, path),
						React.createElement("span", { className: "drv-header-spacer" }),
						React.createElement("button", { className: "drv-btn drv-btn-revert drv-btn-danger", disabled: !(data && data.revertible === true), onClick: () => revertAllHere() }, "撤回全部"),
						React.createElement("button", { className: "drv-btn", onClick: onClose }, "关闭")),
					React.createElement("div", { className: "dsdrv-max-body" },
						!data
							? React.createElement("div", { className: "drv-empty" }, "加载中…")
							: (data.sections && data.sections.length > 0
								? data.sections.map((sec, i) => React.createElement(Section, { key: i, section: sec, onRevert: (opIndex) => revertOne(opIndex), busy: false }))
								: React.createElement("div", { className: "drv-empty" }, "该文件没有可展示的修改")))));
		}

		// ── 实时变更面板：对话框上方（conversation.input.dock）实时列出本次会话已
		// 修改的文件，显示修改时间与增删行数，点击展开可查看实际 diff；不依赖回合
		// 渲染时机，随 SSE/轮询实时刷新，保证对话过程中就能看到改了什么。
		function LivePanel(props) {
			const files = useStore((s) => s.files);
			const colors = useStore((s) => s.colors);
			const session = useStore((s) => s.currentSession);
			const tick = useStore((s) => s.reviewTick);
			// 绑定到「当前对话」：dock 插槽会把活动会话 id 传进来。若沿用全局
			// store.currentSession，新建/切换对话时容易读到上个会话的过期记录
			// （conversation.session.header.actions 对全新的空会话不一定触发），
			// 导致「变更（实时）」面板在空会话里也残留。这里以 dock 的活动会话为准。
			React.useEffect(() => {
				const sid = props.sessionId;
				if (sid && store.currentSession !== sid) {
					reqSeq++; // 丢弃上一个会话仍在途的请求
					setState({ currentSession: sid, files: null, selected: null, detail: null, mode: "session", turnData: null, latestTurn: 0, error: null, loadingFiles: false, reviewTick: store.reviewTick + 1 });
					refreshFromServer();
				}
			}, [props.sessionId]);
			const [openPath, setOpenPath] = React.useState(null);
			const [collapsed, setCollapsed] = React.useState(false);
			// 最大化查看的文件路径；非空时弹出全屏 diff 大窗口
			const [maximized, setMaximized] = React.useState(null);
			const [detail, setDetail] = React.useState(null);
			// 用 ref 同步维护“当前展开的路径”，异步回调通过 ref 判断，
			// 避免闭包捕获到旧 openPath 导致 detail 永远不更新（一直“加载中”）
			const openRef = React.useRef(null);
			const list = files || [];
			// 折叠态下标题栏显示「最后修改的文件」：buildSummary 按 lastTime 降序，
			// list[0] 即最近被修改的文件；折叠时纯展示、不可点击打开。
			const lastFile = list.length > 0 ? list[0] : null;
			const lastFileName = lastFile ? (String(lastFile.path || "").split(/[\/\\]/).pop() || lastFile.name || "") : "";
			// 当前展开的文件被清空/移除时自动收起
			React.useEffect(() => {
				if (openRef.current && !(files || []).some((f) => f.path === openRef.current)) {
					openRef.current = null;
					setOpenPath(null);
					setDetail(null);
				}
			}, [openPath, files]);
			// 展开期间随后端数据刷新（reviewTick）实时重拉，diff 保持最新
			React.useEffect(() => {
				if (!session || !openRef.current || tick === 0) return;
				let alive = true;
				apiFile(session, openRef.current).then((v) => {
					if (alive && openRef.current) setDetail(v);
				}).catch(() => {});
				return () => { alive = false; };
			}, [session, tick]);
			if (!session || list.length === 0) return null;
			const toggle = (p) => {
				if (openRef.current === p) { openRef.current = null; setOpenPath(null); setDetail(null); return; }
				openRef.current = p;
				setOpenPath(p); setDetail(null);
				apiFile(session, p).then((v) => {
					if (openRef.current === p) setDetail(v);
				}).catch(() => {});
			};
			const revertOp = async (path, opIndex) => {
				if (!session || !path) return;
				if (!(await askConfirm("确定撤回该项修改？此操作会直接改写磁盘上的文件，且不可撤销。"))) return;
				apiRevert(session, path, opIndex).then((v) => {
					if (v && v.ok) { apiFile(session, path).then((nv) => setDetail(nv)).catch(() => {}); refreshFromServer(); }
					else window.alert("撤回失败：" + ((v && v.error) || "未知错误"));
				}).catch((e) => window.alert("撤回失败：" + String((e && e.message) || e)));
			};
			const revertAll = async (path) => {
				if (!session || !path) return;
				if (!(await askConfirm("确定撤回该文件的全部修改？此操作会直接改写磁盘上的文件，且不可撤销。"))) return;
				apiRevert(session, path, null).then((v) => {
					if (v && v.ok) refreshFromServer();
					else window.alert("撤回失败：" + ((v && v.error) || "未知错误"));
				}).catch((e) => window.alert("撤回失败：" + String((e && e.message) || e)));
			};
			return React.createElement(React.Fragment, null,
				React.createElement("div", { className: "dsdrv-livepanel" },
				React.createElement("div", { className: "dsdrv-livepanel-card" },
				React.createElement("div", { className: "dsdrv-livepanel-head" + (collapsed ? "" : " dsdrv-livepanel-head-open") },
					React.createElement("span", { className: "dsdrv-livepanel-icon" },
						React.createElement("svg", { width: 18, height: 18, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" },
							React.createElement("circle", { cx: 12, cy: 12, r: 9 }),
							React.createElement("path", { d: "M12 6.5v5.5l3.5 2" }))),
					React.createElement("span", { className: "dsdrv-livepanel-title" }, "变更（实时）"),
					React.createElement("span", { className: "dsdrv-livepanel-count" }, list.length + " 个文件"),
					collapsed ? React.createElement("span", { className: "dsdrv-livepanel-last", title: lastFile ? lastFile.path : "" }, "最近修改：" + lastFileName) : null,
					React.createElement("span", { className: "drv-header-spacer" }),
					React.createElement("button", { type: "button", className: "dsdrv-livepanel-collapse", title: collapsed ? "展开" : "折叠", onClick: () => setCollapsed(!collapsed) },
						React.createElement("svg", { width: 13, height: 13, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2.5, strokeLinecap: "round", strokeLinejoin: "round" },
							collapsed ? React.createElement("polyline", { points: "18 15 12 9 6 15" }) : React.createElement("polyline", { points: "6 9 12 15 18 9" })))),
				collapsed ? null : React.createElement("div", { className: "dsdrv-livepanel-list" + (list.length > 5 && !openPath ? " dsdrv-livepanel-list-scroll" : "") },
					list.map((f) => {
						const open = openPath === f.path;
						const time = fmtTime(f.lastTime);
						return React.createElement("div", { key: f.path, className: "dsdrv-livepanel-file" },
							React.createElement("button", { type: "button", className: "dsdrv-livepanel-row", onClick: () => toggle(f.path) },
								React.createElement("span", { className: "dsdrv-livepanel-name" }, String(f.path || "").split(/[\/\\]/).pop() || f.name || ""),
								(f.turns && f.turns.length) ? React.createElement("span", {
									className: "dsdrv-livepanel-turn",
									title: "该文件在第 " + f.turns.join("、") + " 轮被修改"
								}, f.turns.map((t) => "第" + t + "轮").join("、")) : null,
								React.createElement("span", { className: "drv-header-spacer" }),
								React.createElement("span", { className: "dsdrv-livepanel-diff" },
									React.createElement("span", { style: { color: colors.turnAdd } }, "+" + f.added),
									React.createElement("span", { style: { color: colors.turnDel } }, "−" + f.removed)),
								React.createElement("span", { className: "dsdrv-livepanel-time" }, time),
								React.createElement("span", { className: "drv-turn-chevron" }, open ? "▾" : "▸")),
							open ? React.createElement("div", { className: "dsdrv-livepanel-detail" },
								React.createElement("div", { className: "drv-detail-toolbar" },
									React.createElement("span", { className: "drv-detail-path", title: f.path }, f.path),
									React.createElement("span", { className: "drv-header-spacer" }),
									React.createElement("button", { className: "drv-btn", title: "最大化查看", onClick: () => setMaximized(f.path) }, "最大化查看"),
									React.createElement("button", { className: "drv-btn drv-btn-revert drv-btn-danger", disabled: f.revertible !== true, onClick: () => revertAll(f.path) }, "撤回全部")),
								detail === null
									? React.createElement("div", { className: "drv-empty" }, "加载中…")
									: (detail.sections && detail.sections.length > 0
										? detail.sections.map((sec, i) => React.createElement(Section, { key: i, section: sec, onRevert: (opIndex) => revertOp(f.path, opIndex), busy: false }))
										: React.createElement("div", { className: "drv-empty" }, "该文件没有可展示的修改"))) : null);
					})))) ,
					maximized ? React.createElement(MaximizeDialog, { path: maximized, onClose: () => setMaximized(null), onRevert: revertOp, onRevertAll: (p) => revertAll(p) }) : null,
					React.createElement(ConfirmPrompt, null));
		}

		function TabLabel() {
			const files = useStore((s) => s.files);
			const colors = useStore((s) => s.colors);
			const count = files ? files.length : 0;
			return React.createElement("span", { className: "drv-tab-label" },
				React.createElement("span", null, "审查"),
				count > 0 ? React.createElement("span", {
					className: "drv-tab-badge",
					style: { background: colors.badgeBg, color: colors.badgeFg }
				}, String(count)) : null);
		}

		function TurnReview({ matched, sessionId, turn: turnLoc, seq, openFile }) {
			const colors = useStore((s) => s.colors);
			const liveSession = useStore((s) => s.currentSession);
			const tick = useStore((s) => s.reviewTick);
			const turnNo = matched && matched.turn;
			// turnTail slot 不会把 sessionId 传进来，回退到共享 store 的当前会话
			const sid = sessionId || liveSession;
			const [data, setData] = React.useState(null);
			const [expanded, setExpanded] = React.useState(null);
			const [busy, setBusy] = React.useState(false);
			const [menu, setMenu] = React.useState(null);
			React.useEffect(() => {
				let alive = true;
				setData(null);
				if (sid && turnNo != null) {
					apiTurn(sid, turnNo).then((v) => {
						if (alive) setData(v);
					}).catch(() => {
						if (alive) setData(null);
					});
				}
				return () => { alive = false; };
			}, [sid, turnNo]);
			// 对话过程中（本回合还没结束）SSE 每次刷新就实时重拉本轮数据：
			// 不清空旧数据，避免闪烁，让“本轮变更审查”在回合进行中就逐条出现
			React.useEffect(() => {
				if (!sid || turnNo == null || tick === 0) return;
				let alive = true;
				apiTurn(sid, turnNo).then((v) => {
					if (alive) setData(v);
				}).catch(() => {
					/* 忽略瞬时失败，等待下一次刷新 */
				});
				return () => { alive = false; };
			}, [sid, turnNo, tick]);
			// This entry wins the turnTail chain, so re-render the shipped
			// "produced files" chips from the deliverables turn data to avoid
			// shadowing that built-in feature.
			const produced = [];
			try {
				const dv = turnLoc && turnLoc.data ? turnLoc.data.get("deliverables") : null;
				if (dv && dv.produced) {
					const seen = new Set();
					for (const item of dv.produced) {
						if (item && typeof item.path === "string" && item.seq <= seq && !seen.has(item.path)) {
							seen.add(item.path);
							produced.push(item.path);
						}
					}
				}
			} catch (e) {}
			const hasFiles = data && data.files && data.files.length > 0;
			if (!hasFiles && produced.length === 0) return null;
			const revertOp = async (filePath, opIndex) => {
				if (!sid || !filePath) return;
				if (!(await askConfirm("确定撤回该项修改？此操作会直接改写磁盘上的文件，且不可撤销。"))) return;
				setBusy(true);
				apiRevert(sid, filePath, opIndex).then((v) => {
					if (v && v.ok) {
						apiTurn(sid, turnNo).then((nv) => { if (nv) setData(nv); }).catch(() => {});
						refreshFromServer();
					} else {
						window.alert("撤回失败：" + ((v && v.error) || "未知错误"));
					}
				}).catch((e) => {
					window.alert("撤回失败：" + String((e && e.message) || e));
				}).finally(() => setBusy(false));
			};
			const showCtx = (e, path, cwd) => {
				e.preventDefault(); e.stopPropagation();
				setMenu({ x: e.clientX, y: e.clientY, items: [
					{ label: "打开文件", run: () => { if (sid) openFileFor(sid, path, cwd); } },
					{ label: "在 Finder 中展示", run: () => { if (sid) revealInFinderFor(sid, path, cwd); } }
				]});
			};
			return React.createElement("div", { className: "drv-turn", style: { background: colors.turnBg, borderColor: colors.turnBorder } },
				React.createElement(CtxMenu, { menu, onClose: () => setMenu(null) }),
				produced.length > 0 ? React.createElement("div", { className: "drv-turn-produced" },
					React.createElement("span", { className: "drv-turn-produced-label" }, "产物"),
					produced.map((path) => React.createElement("button", {
						type: "button",
						key: path,
						className: "drv-turn-produced-chip",
						title: path,
						onClick: () => { if (sid) openFileFor(sid, path, null); },
						onContextMenu: (e) => showCtx(e, path, null)
					}, String(path).split('/').pop()))) : null,
				hasFiles ? React.createElement(React.Fragment, null,
					React.createElement("div", { className: "drv-turn-head" },
						React.createElement("span", { className: "drv-turn-title" }, "本轮变更审查"),
						React.createElement("span", { className: "drv-count" }, data.files.length + " 个文件"),
						React.createElement("span", { className: "drv-header-spacer" }),
						React.createElement("span", { className: "drv-turn-hint" }, "会话累计变更见「审查」标签")),
					data.files.map((f) => {
						const open = expanded === f.path;
						return React.createElement("div", { key: f.path, className: "drv-turn-file" },
							React.createElement("button", {
								type: "button",
								className: "drv-turn-file-head",
								onClick: () => setExpanded(open ? null : f.path),
								onContextMenu: (e) => showCtx(e, f.path, f.cwd)
							},
								React.createElement("span", { className: "drv-turn-file-name" }, f.name),
								React.createElement("span", { className: "drv-file-meta" },
									(f.writes > 0 ? "写入×" + f.writes + " " : "") + (f.edits > 0 ? "编辑×" + f.edits : ""),
									React.createElement("span", { style: { color: colors.turnAdd } }, "  ~+" + f.added),
									React.createElement("span", { style: { color: colors.turnDel } }, "  ~−" + f.removed)),
								React.createElement("span", { className: "drv-header-spacer" }),
								React.createElement("span", { className: "drv-turn-chevron" }, open ? "▾" : "▸")),
							open ? React.createElement("div", { className: "drv-turn-file-body" },
								f.sections.map((sec, i) => React.createElement(Section, {
									key: i, section: sec,
									onRevert: (opIndex) => revertOp(f.path, opIndex),
									busy: busy
								}))) : null);
					})) : null,
					React.createElement(ConfirmPrompt, null));
		}

		function ReviewView(props) {
			React.useEffect(() => {
				if (props.sessionId) {
					if (store.currentSession !== props.sessionId) {
						reqSeq++;
						setState({ currentSession: props.sessionId, files: null, selected: null, detail: null, mode: "session", turnData: null, latestTurn: 0, error: null, loadingFiles: true });
					}
					loadSummary();
				}
			}, [props.sessionId]);
			const files = useStore((s) => s.files);
			const mode = useStore((s) => s.mode);
			const turnData = useStore((s) => s.turnData);
			const count = mode === "latest" ? (((turnData && turnData.files) || []).length) : (files ? files.length : 0);
			const [busy, setBusy] = React.useState(false);
			const [notice, setNotice] = React.useState(null);
			const noticeTimer = React.useRef(null);
			const showNotice = (msg) => {
				setNotice(msg);
				if (noticeTimer.current) clearTimeout(noticeTimer.current);
				noticeTimer.current = setTimeout(() => setNotice(null), 4000);
			};
			React.useEffect(() => () => { if (noticeTimer.current) clearTimeout(noticeTimer.current); }, []);
			const doRevert = async (op) => {
				const session = store.currentSession;
				const path = store.selected;
				if (!session || !path) return;
				const what = op === null ? "该文件的全部修改" : "该项修改";
				if (!(await askConfirm("确定撤回" + what + "？此操作会直接改写磁盘上的文件，且不可撤销。"))) return;
				setBusy(true);
				apiRevert(session, path, op).then((v) => {
					if (v && v.ok) {
						showNotice(v.message || "已撤回");
						if (op === null) setState({ selected: null, detail: null });
						refresh();
					} else {
						window.alert("撤回失败：" + ((v && v.error) || "未知错误"));
					}
				}).catch((e) => {
					window.alert("撤回失败：" + String((e && e.message) || e));
				}).finally(() => setBusy(false));
			};
			const revertOp = (opIndex) => doRevert(opIndex);
			const revertAll = () => doRevert(null);
			return React.createElement("div", { className: "drv-view" },
				React.createElement("div", { className: "drv-view-header" },
					React.createElement("span", { className: "drv-title" }, "修改审查"),
					React.createElement("span", { className: "drv-count" }, (mode === "latest" ? "最新一轮 · " : "") + count + " 个文件"),
					React.createElement("div", { className: "drv-mode", role: "group" },
						React.createElement("button", {
							className: "drv-mode-btn" + (mode === "session" ? " drv-mode-active" : ""),
							onClick: () => setMode("session")
						}, "此会话"),
						React.createElement("button", {
							className: "drv-mode-btn" + (mode === "latest" ? " drv-mode-active" : ""),
							onClick: () => setMode("latest")
						}, "最新一轮")),
					React.createElement("span", { className: "drv-header-spacer" }),
					notice ? React.createElement("span", { className: "drv-notice" }, notice) : null,
					React.createElement("button", { className: "drv-btn", title: "刷新", onClick: refresh }, "↻"),
					React.createElement("button", {
						className: "drv-btn", title: "清空记录",
						onClick: () => { apiClear(store.currentSession).then(() => { setState({ files: [], detail: null, selected: null, turnData: null, latestTurn: 0 }); }); }
					}, "清空")),
				React.createElement("div", { className: "drv-view-body" },
					React.createElement("div", { className: "drv-filelist" }, React.createElement(FileList, { openFile: props.openFile })),
					React.createElement("div", { className: "drv-detail" }, React.createElement(Detail, { onRevert: revertOp, onRevertAll: revertAll, busy: busy }))),
				React.createElement(ConfirmPrompt, null));
		}

		function SettingsPage() {
			return React.createElement("div", { className: "drv-settings-page" },
				React.createElement("p", { className: "drv-settings-desc" },
					"「修改审查」追踪进程内通过写入 / 编辑工具产生的文件修改，并在会话视图标签「审查」中展示修改对比。下方可自定义 diff 展示颜色与标签角标颜色，改动即时生效并自动保存（刷新页面后保留）。默认颜色随 DSH 外观（浅色/深色）自动切换；「恢复默认」恢复到当前外观对应的颜色。"),
				React.createElement(ColorRows, null),
				React.createElement(PresetButtons, null));
		}

		// ── editor picker: choose the default code editor for「打开文件」 ──────
		function EditorIcon({ id, size }) {
			return React.createElement("img", {
				src: "/diff-review/editor-icon/" + encodeURIComponent(id),
				style: { width: size || 16, height: size || 16, verticalAlign: "middle", borderRadius: 3, flexShrink: 0 },
				alt: "",
				onError: (e) => { e.target.style.display = "none"; }
			});
		}
		function EditorPicker(props) {
			const editors = useStore((s) => s.editors);
			const editorLoading = useStore((s) => s.editorLoading);
			const selectedEditor = useStore((s) => s.selectedEditor);
			const [open, setOpen] = React.useState(false);
			const rootRef = React.useRef(null);
			React.useEffect(() => { loadEditors(); }, []);
			React.useEffect(() => {
				if (!open) return;
				const onDoc = (e) => {
					if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false);
				};
				document.addEventListener("mousedown", onDoc, true);
				document.addEventListener("keydown", (e) => { if (e.key === "Escape") setOpen(false); }, true);
				return () => {
					document.removeEventListener("mousedown", onDoc, true);
					document.removeEventListener("keydown", (e) => { if (e.key === "Escape") setOpen(false); }, true);
				};
			}, [open]);
			const detected = (editors || []).filter((e) => e.detected);
			const label = selectedEditor ? "用" + selectedEditor.name + "打开" : "编辑器";
			return React.createElement("div", { className: "drv-editor", ref: rootRef },
				React.createElement("button", {
					type: "button",
					className: "drv-editor-btn",
					title: selectedEditor ? "当前默认编辑器：" + selectedEditor.name + "（点击更换）" : "选择打开文件时使用的代码编辑器",
					onClick: () => setOpen(!open)
				},
					React.createElement("span", { className: "drv-editor-label" },
						editorLoading ? "检测中…" : (selectedEditor ? React.createElement(React.Fragment, null,
							React.createElement(EditorIcon, { id: selectedEditor.id, size: 16 }),
							" " + label) : label)),
					React.createElement("span", { className: "drv-editor-caret" }, open ? "▴" : "▾")),
				open ? React.createElement("div", { className: "drv-editor-menu" },
					detected.length === 0 ? React.createElement("div", { className: "drv-editor-empty" }, "未检测到已安装的代码编辑器") : null,
					React.createElement("button", {
						type: "button",
						className: "drv-editor-opt" + (!selectedEditor ? " drv-editor-opt-active" : ""),
						onClick: () => { selectEditor(null); setOpen(false); }
					}, "系统默认"),
					detected.map((ed) => React.createElement("button", {
						type: "button",
						key: ed.id,
						className: "drv-editor-opt" + (selectedEditor && selectedEditor.id === ed.id ? " drv-editor-opt-active" : ""),
						style: { display: "flex", alignItems: "center", gap: 6 },
						onClick: () => { selectEditor(ed); setOpen(false); }
					},
						React.createElement(EditorIcon, { id: ed.id, size: 16 }),
						React.createElement("span", null, ed.name)))) : null);
		}

		// ── plugin ─────────────────────────────────────────────────────────
		const inject = ["slots", "sessions", "theme", "workspaces"];
		const CSS = `
.drv-view { flex:1 1 0; min-height:0; overflow:hidden; display:flex; flex-direction:column; padding:12px 14px; box-sizing:border-box; font-size:13px; }
.drv-view-header { display:flex; align-items:center; gap:8px; padding:4px 0 10px; border-bottom:1px solid rgba(128,128,128,0.3); }
.drv-title { font-weight:600; }
.drv-count { opacity:0.7; font-size:12px; }
.drv-header-spacer { flex:1; }
.drv-btn { border:none; background:rgba(128,128,128,0.12); color:inherit; cursor:pointer; border-radius:6px; padding:4px 8px; font-size:12px; }
.drv-btn:hover { background:rgba(128,128,128,0.25); }
.drv-view-body { flex:1; display:flex; min-height:0; margin-top:10px; border:1px solid rgba(128,128,128,0.3); border-radius:8px; overflow:hidden; }
.drv-filelist { width:250px; border-right:1px solid rgba(128,128,128,0.3); overflow:auto; overscroll-behavior:contain; flex-shrink:0; padding:6px 0; }
.drv-file { display:flex; align-items:center; gap:6px; width:100%; padding:6px 10px; cursor:pointer; border:none; background:transparent; color:inherit; text-align:left; font-family:inherit; font-size:12.5px; }
.drv-file:hover { background:rgba(128,128,128,0.12); }
.drv-file.drv-selected { background:rgba(80,120,255,0.18); }
.drv-file-name { font-weight:500; word-break:break-all; }
.drv-file-meta { font-size:11px; opacity:0.75; white-space:nowrap; }
.drv-detail { flex:1; overflow:auto; overscroll-behavior:contain; padding:10px; }
.drv-section { margin-bottom:12px; border:1px solid rgba(128,128,128,0.35); border-radius:6px; overflow:hidden; }
.drv-section-head { padding:6px 10px; font-weight:600; background:rgba(128,128,128,0.1); display:flex; gap:8px; align-items:center; }
.drv-section-time { font-weight:400; opacity:0.7; font-size:11px; }
.drv-badge { display:inline-block; padding:0 6px; border-radius:8px; font-size:10px; font-weight:600; }
.drv-badge-new { background:rgba(46,160,67,0.22); color:#1a7f37; }
.drv-badge-edit { background:rgba(9,105,218,0.16); color:#0969da; }
.drv-line { display:flex; font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:12px; line-height:1.55; }
.drv-gutter { flex:0 0 42px; text-align:right; padding:0 6px; user-select:none; opacity:0.9; }
.drv-gutter-sign { flex:0 0 18px; text-align:center; padding:0 2px; }
.drv-text { flex:1; padding:0 6px; white-space:pre-wrap; word-break:break-word; }
.drv-empty { padding:24px; text-align:center; opacity:0.6; }
.drv-settings { border-top:1px solid rgba(128,128,128,0.3); padding:6px 0 0; margin-top:10px; }
.drv-settings-toggle { border:none; background:transparent; color:inherit; cursor:pointer; font-size:12px; padding:4px 0; }
.drv-settings-body { margin-top:6px; }
.drv-color-row { display:flex; align-items:center; justify-content:space-between; gap:8px; padding:3px 0; font-size:12px; }
.drv-color-row input[type=color] { width:38px; height:24px; border:none; border-radius:4px; padding:0; background:transparent; cursor:pointer; }
.drv-color-controls { display:flex; align-items:center; gap:6px; }
.drv-color-controls input[type=range] { width:76px; accent-color:var(--dsw-alias-state-business-primary, #4493f8); }
.drv-color-alpha { font-size:11px; opacity:0.7; min-width:34px; text-align:right; }
.drv-presets { display:flex; gap:6px; margin-top:8px; }
.drv-presets button { border:1px solid rgba(128,128,128,0.4); background:transparent; color:inherit; cursor:pointer; border-radius:6px; padding:3px 8px; font-size:11px; }
.drv-presets button:hover { background:rgba(128,128,128,0.15); }
.drv-settings-page { padding:16px; font-size:13px; }
.drv-settings-desc { opacity:0.7; margin:0 0 14px; line-height:1.6; }
.drv-detail-toolbar { display:flex; align-items:center; gap:8px; margin-bottom:10px; }
.drv-detail-path { font-size:12px; opacity:0.8; word-break:break-all; }
.drv-btn-revert { font-size:11px; padding:2px 8px; }
.drv-btn-danger { color:#cf222e; }
.drv-notice { font-size:12px; color:#1a7f37; background:rgba(46,160,67,0.15); border-radius:6px; padding:3px 8px; }
.drv-mode { display:flex; gap:4px; }
.drv-mode-btn { border:1px solid rgba(128,128,128,0.4); background:transparent; color:inherit; cursor:pointer; border-radius:6px; padding:2px 8px; font-size:11px; }
.drv-mode-btn:hover { background:rgba(128,128,128,0.12); }
.drv-mode-btn.drv-mode-active { background:rgba(80,120,255,0.25); border-color:rgba(80,120,255,0.6); }
.drv-turn { border:1px solid rgba(128,128,128,0.3); border-radius:8px; padding:6px 10px; font-size:12px; }
.drv-turn-produced { display:flex; align-items:center; gap:6px; flex-wrap:wrap; padding:0 0 6px; }
.drv-turn-produced-label { font-size:11px; opacity:0.7; }
.drv-turn-produced-chip { border:1px solid rgba(128,128,128,0.35); background:transparent; color:inherit; cursor:pointer; border-radius:10px; padding:1px 8px; font-size:11px; font-family:inherit; }
.drv-turn-produced-chip:hover { background:rgba(128,128,128,0.12); }
.drv-turn-head { display:flex; align-items:center; gap:8px; padding:2px 0 6px; }
.drv-turn-title { font-weight:600; }
.drv-turn-hint { font-size:11px; opacity:0.6; }
.drv-turn-file { border-top:1px solid rgba(128,128,128,0.15); }
.drv-turn-file-head { display:flex; align-items:center; gap:8px; width:100%; padding:5px 0; border:none; background:transparent; color:inherit; cursor:pointer; font-family:inherit; font-size:12px; text-align:left; }
.drv-turn-file-name { font-weight:500; word-break:break-all; }
.dsdrv-livepanel { box-sizing:border-box; width: calc(100% - var(--dsh-composer-side-clearance,16px) - var(--dsh-composer-side-clearance,16px) - 4px); margin:0 auto; }
.dsdrv-livepanel-card { box-sizing:border-box; width:100%; max-width: var(--dsh-composer-card-max-width,780px); margin:0 auto; border:1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.3)); background:var(--dsw-alias-bg-layer-2, #22272e); border-radius:12px; overflow:hidden; }
.dsdrv-livepanel-head { box-sizing:border-box; width:100%; display:flex; align-items:center; gap:10px; height:36px; padding:0 6px 0 12px; background:var(--dsw-specific-tip, transparent); }
.dsdrv-livepanel-head-open { border-bottom:1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.2)); }
.dsdrv-livepanel-icon { flex:none; display:inline-flex; color:var(--dsw-alias-label-tertiary, #8b949e); }
.dsdrv-livepanel-title { flex:none; font-size:13px; font-weight:500; }
.dsdrv-livepanel-count { flex:none; opacity:0.6; font-size:11px; }
.dsdrv-livepanel-last { flex:none; font-size:12px; opacity:0.85; max-width:240px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; cursor:default; }
.dsdrv-livepanel-collapse { width:28px; height:28px; flex:none; border:none; background:transparent; color:var(--dsw-alias-label-tertiary, #8b949e); cursor:pointer; border-radius:999px; padding:0; display:inline-flex; align-items:center; justify-content:center; }
.dsdrv-livepanel-collapse:hover { background:transparent; color:var(--dsw-alias-label-primary, inherit); }
.dsdrv-livepanel-list { box-sizing:border-box; width:100%; padding:4px; }
/* 超过 5 个文件时限制可见高度为 5 行，出现滚动条 */
.dsdrv-livepanel-list-scroll { max-height:156px; overflow-y:auto; overscroll-behavior:contain; }
.dsdrv-livepanel-file { border:1px solid rgba(128,128,128,0.3); border-radius:8px; margin-bottom:4px; overflow:hidden; }
.dsdrv-livepanel-row { display:flex; align-items:center; gap:8px; width:100%; padding:4px 8px; border:none; background:transparent; color:inherit; cursor:pointer; font-family:inherit; font-size:11.5px; text-align:left; }
.dsdrv-livepanel-row:hover { background:rgba(128,128,128,0.12); }
.dsdrv-livepanel-name { font-weight:500; word-break:break-all; }
.dsdrv-livepanel-turn { flex:none; font-size:10px; opacity:0.75; border:1px solid rgba(128,128,128,0.35); border-radius:8px; padding:0 5px; line-height:15px; white-space:nowrap; }
.dsdrv-livepanel-diff { font-size:11px; white-space:nowrap; }
.dsdrv-livepanel-time { font-size:11px; opacity:0.7; white-space:nowrap; }
.dsdrv-livepanel-detail { padding:6px 8px; border-top:1px solid rgba(128,128,128,0.2); max-height:280px; overflow-y:auto; }
.dsdrv-max-mask { position:fixed; inset:0; z-index:30000; display:flex; align-items:center; justify-content:center; background:rgba(0,0,0,0.5); padding:24px; box-sizing:border-box; }
.dsdrv-max { box-sizing:border-box; width:min(960px, 92vw); height:min(80vh, 640px); display:flex; flex-direction:column; border:1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.4)); border-radius:14px; background:var(--dsw-alias-bg-base, #1c2128); box-shadow:0 18px 60px rgba(0,0,0,0.5); overflow:hidden; }
.dsdrv-max-head { display:flex; align-items:center; gap:8px; padding:10px 14px; border-bottom:1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.25)); flex:none; }
.dsdrv-max-body { flex:1; min-height:0; overflow-y:auto; padding:12px 14px; }
.dsdrv-modal-mask { position:fixed; inset:0; z-index:40000; display:flex; align-items:center; justify-content:center; background:rgba(0,0,0,0.45); }
.dsdrv-modal { min-width:280px; max-width:420px; padding:16px; border:1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.4)); border-radius:12px; background:var(--dsw-alias-surface-2, #22272e); box-shadow:0 10px 30px rgba(0,0,0,0.4); }
.dsdrv-modal-text { font-size:13px; line-height:1.6; margin-bottom:14px; }
.dsdrv-modal-btns { display:flex; justify-content:flex-end; gap:8px; }
.dsdrv-modal-btns .drv-btn { padding:5px 14px; }
.drv-turn-chevron { opacity:0.6; }
.drv-turn-file-body { padding:2px 0 8px; }
.drv-turn-file-body .drv-section { margin-bottom:8px; }
.drv-tab-label { display:inline-flex; align-items:center; gap:6px; }
.drv-tab-badge { display:inline-block; border-radius:8px; padding:0 5px; font-size:10px; line-height:14px; font-weight:600; min-width:16px; text-align:center; }
.dsdrv-ctx { position:fixed; z-index:20000; min-width:150px; padding:4px; border:1px solid rgba(128,128,128,0.45); border-radius:8px; background:var(--dsw-alias-surface-2, #22272e); box-shadow:0 6px 18px rgba(0,0,0,0.35); }
.dsdrv-ctx-item { display:block; width:100%; border:none; background:transparent; color:inherit; text-align:left; padding:6px 10px; border-radius:6px; font-size:12px; font-family:inherit; cursor:pointer; }
.dsdrv-ctx-item:hover { background:rgba(80,120,255,0.28); }
.drv-editor { position:relative; display:inline-flex; }
.drv-editor-btn { display:inline-flex; align-items:center; gap:4px; height:32px; padding:0 10px; border:1px solid rgba(128,128,128,0.35); background:transparent; color:inherit; cursor:pointer; border-radius:18px; font-size:12px; font-family:inherit; }
.drv-editor-btn:hover { background:rgba(128,128,128,0.14); }
.drv-editor-label { max-width:110px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.drv-editor-caret { opacity:0.7; font-size:10px; flex:none; }
.drv-editor-menu { position:absolute; top:calc(100% + 4px); right:0; z-index:20000; min-width:170px; padding:4px; border:1px solid rgba(128,128,128,0.45); border-radius:8px; background:var(--dsw-alias-surface-2, #22272e); box-shadow:0 6px 18px rgba(0,0,0,0.35); max-height:260px; overflow:auto; }
.drv-editor-opt { display:block; width:100%; border:none; background:transparent; color:inherit; text-align:left; padding:6px 10px; border-radius:6px; font-size:12px; font-family:inherit; cursor:pointer; white-space:nowrap; }
.drv-editor-opt:hover { background:rgba(128,128,128,0.16); }
.drv-editor-opt.drv-editor-opt-active { background:rgba(80,120,255,0.28); }
.drv-editor-empty { padding:6px 10px; font-size:12px; opacity:0.6; }
`;
		function apply(ctx) {
			ctxRef = ctx;
			// ── 让 diff 颜色随 DSH 外观（浅色/深色）自动切换 ──────────────
			const themeApi = ctx && ctx.theme;
			const getScheme = () => {
				try {
					const snap = themeApi && themeApi.getTheme ? themeApi.getTheme() : null;
					if (snap && snap.active && snap.active.colorScheme) return snap.active.colorScheme;
				} catch (e) {}
				// DOM 兜底：桌面壳把深色标记写在 body 上
				if (document.body && document.body.hasAttribute("data-ds-dark-theme")) return "dark";
				if (document.documentElement && document.documentElement.style.colorScheme === "dark") return "dark";
				return "light";
			};
			// 初始化：没有持久化的自定义色时，默认按当前外观取对应的一套色板，
			// 避免深色外观下仍用浅色色板而出现“白色方块”。
			store.scheme = getScheme();
			if (!hasSavedColors) setColorsQuiet(Object.assign({}, paletteFor(store.scheme)));
			// 监听外观变化，随外观强制切换到对应色板
			if (typeof ctx.on === "function") {
				ctx.effect(() => {
					const off = ctx.on("theme/change", (snapshot) => {
						let s;
						try { s = snapshot && snapshot.active && snapshot.active.colorScheme; } catch (e) {}
						if (!s) s = getScheme();
						if (s && s !== store.scheme) {
							store.scheme = s;
							setColorsQuiet(Object.assign({}, paletteFor(s)));
						}
					});
					return () => { if (off) off(); };
				}, "diff-review: theme follow");
			}
			ctx.effect(() => {
				const el = document.createElement("style");
				el.textContent = CSS;
				document.head.appendChild(el);
				return () => el.remove();
			}, "diff-review: styles");
			loadEditors();
			refreshFromServer();
			ctx.effect(connectEvents, "diff-review: live events");
			// 轮询兜底：即使 SSE 偶发断连/未建立，也能近实时地把修改文件刷上界面
			ctx.effect(() => {
				const timer = setInterval(() => {
					if (store.currentSession) refreshFromServer();
				}, 2500);
				return () => clearInterval(timer);
			}, "diff-review: live poll");
			ctx.slots.inject("conversation.view", () => ctx.slots.register(
				{
					name: "conversation.view", id: "review", order: 5,
					label: () => React.createElement(TabLabel, null),
					inject: (sessionId, _actions) => ({
						openFile: (path, cwd) => openFileFor(sessionId, path, cwd)
					})
				},
				(props) => React.createElement(ReviewView, props)));
			ctx.slots.inject("conversation.chat.turnTail", () => ctx.slots.register(
				{ name: "conversation.chat.turnTail", priority: -1, select: (owner) => (owner && owner.turn && owner.turn.turn != null ? { turn: owner.turn.turn } : null) },
				(props) => React.createElement(TurnReview, props)));
			ctx.slots.inject("conversation.session.header.utilities", () => ctx.slots.register(
				{ name: "conversation.session.header.utilities", id: "diff-review-editor", order: -1 },
				(props) => React.createElement(EditorPicker, props)));
			ctx.slots.inject("conversation.input.dock", () => ctx.slots.register(
				{ name: "conversation.input.dock", id: "diff-review-live", order: 20, inject: (sessionId) => ({ sessionId }) },
				(props) => React.createElement(LivePanel, props)));
			ctx.slots.inject("conversation.session.header.actions", () => ctx.slots.register(
				{ name: "conversation.session.header.actions", id: "diff-review-session", order: 100 },
				(props) => React.createElement(SessionProbe, props)));
			ctx.slots.inject("settings.section", () => ctx.slots.register(
				{ name: "settings.section", id: "diff-review", order: 25, label: "修改审查" },
				(props) => React.createElement(SettingsPage, props)));
			ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register(
				{ name: "sidebar.footer.action", id: "diff-review" },
				() => null));
		}

		exports.inject = inject;
		exports.apply = apply;
		return module.exports;
	}
});