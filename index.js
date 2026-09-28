import { renderExtensionTemplateAsync } from '../../extensions.js';

const EXTENSION_NAME = 'st-extension-importer';
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
const MAX_TOTAL_UNCOMPRESSED = 2 * 1024 * 1024 * 1024;
const MAX_FILES = 10000;

const BUILTIN_NAMES = new Set([
    'memory', 'regex', 'quick-reply', 'tts', 'vectors', 'token-counter', 'caption',
    'attachments', 'assets', 'gallery', 'connection-manager', 'expressions',
    'stable-diffusion', 'translate', 'code-render', 'data-migration',
    'tauritavern-version', 'agent-system', 'mcp-manager',
]);

let entries = [];
let selectedFile = null;
let selectedZip = null;

function getSafeInvoke() {
    const invoke = window.__TAURITAVERN__?.invoke?.safeInvoke;
    if (typeof invoke === 'function') return invoke;
    const raw = window.__TAURI__?.core?.invoke;
    if (typeof raw === 'function') return raw;
    throw new Error('Tauri invoke API is unavailable');
}

function getRawInvoke() {
    const invoke = window.__TAURI__?.core?.invoke;
    if (typeof invoke === 'function') return invoke;
    throw new Error('Tauri core invoke API is unavailable');
}

async function fsInvoke(command, args, body, headers) {
    const invoke = getRawInvoke();
    if (body !== undefined) return invoke(command, body, { headers });
    return invoke(command, args);
}

function setStatus(text, muted = false) {
    $('#stei_status').text(String(text || ''))
        .toggleClass('stei-muted', muted);
}

function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, ch => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[ch]));
}

function normalizeZipPath(raw) {
    let path = String(raw || '').replace(/\\/g, '/');
    path = path.replace(/^\/+/, '');
    const parts = [];
    for (const part of path.split('/')) {
        if (!part || part === '.') continue;
        if (part === '..') throw new Error(`ZIP contains unsafe path: ${raw}`);
        parts.push(part);
    }
    return parts.join('/');
}

function isUnsafeZipPath(path) {
    return !path || path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) || path.split('/').includes('..');
}

function readU16(view, offset) { return view.getUint16(offset, true); }
function readU32(view, offset) { return view.getUint32(offset, true); }

function findEndOfCentralDirectory(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const min = Math.max(0, bytes.byteLength - 0x10000 - 22);
    for (let i = bytes.byteLength - 22; i >= min; i--) {
        if (readU32(view, i) === 0x06054b50) return i;
    }
    throw new Error('不是有效的 ZIP 文件：找不到中央目录');
}

function decodeName(bytes, utf8) {
    try { return new TextDecoder(utf8 ? 'utf-8' : 'utf-8', { fatal: false }).decode(bytes); }
    catch { return new TextDecoder().decode(bytes); }
}

async function inflateRaw(bytes) {
    if (typeof DecompressionStream !== 'function') {
        throw new Error('当前 WebView 不支持 ZIP 的 Deflate 解压');
    }
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function parseZip(arrayBuffer) {
    const bytes = new Uint8Array(arrayBuffer);
    if (bytes.byteLength > MAX_ARCHIVE_BYTES) throw new Error('ZIP 超过 512 MB 限制');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const eocd = findEndOfCentralDirectory(bytes);
    const count = readU16(view, eocd + 10);
    const centralSize = readU32(view, eocd + 12);
    const centralOffset = readU32(view, eocd + 16);
    if (count > MAX_FILES) throw new Error(`ZIP 文件数量超过 ${MAX_FILES}`);
    if (centralOffset + centralSize > bytes.byteLength) throw new Error('ZIP 中央目录越界');

    const result = [];
    let p = centralOffset;
    let total = 0;
    for (let i = 0; i < count; i++) {
        if (readU32(view, p) !== 0x02014b50) throw new Error('ZIP 中央目录损坏');
        const flags = readU16(view, p + 8);
        const method = readU16(view, p + 10);
        const compressedSize = readU32(view, p + 20);
        const uncompressedSize = readU32(view, p + 24);
        const nameLen = readU16(view, p + 28);
        const extraLen = readU16(view, p + 30);
        const commentLen = readU16(view, p + 32);
        const localOffset = readU32(view, p + 42);
        const nameBytes = bytes.subarray(p + 46, p + 46 + nameLen);
        const name = normalizeZipPath(decodeName(nameBytes, Boolean(flags & 0x0800)));
        if (isUnsafeZipPath(name)) throw new Error(`ZIP contains unsafe path: ${name}`);
        const directory = name.endsWith('/');
        if (!directory) {
            total += uncompressedSize;
            if (total > MAX_TOTAL_UNCOMPRESSED) throw new Error('ZIP 解压总大小超过 2 GB');
        }
        result.push({ name, flags, method, compressedSize, uncompressedSize, localOffset, directory });
        p += 46 + nameLen + extraLen + commentLen;
    }

    async function readEntry(entry) {
        if (entry.directory) return new Uint8Array();
        const lp = entry.localOffset;
        if (lp + 30 > bytes.byteLength || readU32(view, lp) !== 0x04034b50) throw new Error(`ZIP 本地头损坏: ${entry.name}`);
        const nameLen = readU16(view, lp + 26);
        const extraLen = readU16(view, lp + 28);
        const start = lp + 30 + nameLen + extraLen;
        const end = start + entry.compressedSize;
        if (end > bytes.byteLength) throw new Error(`ZIP 文件数据越界: ${entry.name}`);
        const compressed = bytes.subarray(start, end);
        if (entry.method === 0) return new Uint8Array(compressed);
        if (entry.method === 8) return inflateRaw(compressed);
        throw new Error(`不支持的 ZIP 压缩方式 ${entry.method}: ${entry.name}`);
    }

    return { entries: result, readEntry };
}

function findExtensionsRoot(names) {
    const candidates = ['public/scripts/extensions/', 'scripts/extensions/', 'extensions/'];
    for (const candidate of candidates) {
        if (names.some(name => name === candidate.slice(0, -1) || name.startsWith(candidate))) return candidate;
    }
    const manifest = names.find(name => /(^|\/)manifest\.json$/i.test(name));
    if (manifest) return manifest.slice(0, manifest.lastIndexOf('/') + 1);
    return '';
}

function makeMappedEntries(zipEntries) {
    const names = zipEntries.map(e => e.name).filter(Boolean);
    const prefix = findExtensionsRoot(names);
    if (prefix) {
        return zipEntries
            .filter(e => e.name === prefix.slice(0, -1) || e.name.startsWith(prefix))
            .map(e => ({ ...e, name: e.name.slice(prefix.length) }))
            .filter(e => e.name);
    }

    // Common wrapper directory: ST-Extensions/extensions/... or public/scripts/extensions/... already handled above.
    const firstParts = names[0]?.split('/') || [];
    if (firstParts.length > 1 && names.every(name => name.startsWith(`${firstParts[0]}/`))) {
        const wrapper = `${firstParts[0]}/`;
        const inner = zipEntries.map(e => ({ ...e, name: e.name.slice(wrapper.length) })).filter(e => e.name);
        const innerRoot = findExtensionsRoot(inner.map(e => e.name));
        if (innerRoot) return inner.map(e => ({ ...e, name: e.name.slice(innerRoot.length) })).filter(e => e.name);
    }
    return zipEntries;
}

async function scanZip(file) {
    const zip = await parseZip(await file.arrayBuffer());
    const mapped = makeMappedEntries(zip.entries);
    const manifestEntries = mapped.filter(e => /(^|\/)manifest\.json$/i.test(e.name) && !e.directory);
    const found = [];
    const usedRoots = new Set();

    for (const manifest of manifestEntries) {
        const parts = manifest.name.split('/');
        if (parts.length < 2) continue;
        const root = parts.slice(0, -1).join('/');
        if (usedRoots.has(root)) continue;
        usedRoots.add(root);
        let meta = {};
        try { meta = JSON.parse(new TextDecoder().decode(await zip.readEntry({ ...manifest, name: manifest.name }))); }
        catch { /* show unknown metadata */ }
        const rootParts = root.split('/');
        const name = rootParts.at(-1) || root;
        const type = rootParts.includes('third-party') ? 'third-party' : (BUILTIN_NAMES.has(name) ? 'builtin' : 'local');
        const fileList = mapped.filter(e => e.name === root || e.name.startsWith(`${root}/`));
        found.push({ root, type, displayName: String(meta.display_name || meta.displayName || name), version: String(meta.version || ''), meta, fileList });
    }

    // Fallback for extensions without manifest.json.
    const roots = new Map();
    for (const e of mapped) {
        if (e.directory || !e.name) continue;
        const parts = e.name.split('/');
        if (parts.length < 2) continue;
        const root = parts.slice(0, -1).join('/');
        if (!roots.has(root)) roots.set(root, []);
        roots.get(root).push(e);
    }
    for (const [root, fileList] of roots) {
        if (usedRoots.has(root)) continue;
        const parts = root.split('/');
        const name = parts.at(-1);
        if (!name || name.startsWith('.') || name === 'node_modules') continue;
        // If we got a recognizable third-party folder, or the archive itself is a single extension folder.
        const isThirdParty = parts.includes('third-party');
        const isBuiltin = BUILTIN_NAMES.has(name);
        const looksLikeExtension = isThirdParty || isBuiltin || parts.length <= 2;
        if (!looksLikeExtension) continue;
        found.push({ root, type: isThirdParty ? 'third-party' : (isBuiltin ? 'builtin' : 'local'), displayName: name, version: '', meta: {}, fileList });
    }

    if (!found.length) throw new Error('没有找到可识别的 SillyTavern 扩展目录');
    return { zip, extensions: found };
}

function targetRelativeRoot(item) {
    const name = item.root.split('/').filter(Boolean).at(-1);
    if (!name || !/^[A-Za-z0-9._-]+$/.test(name)) throw new Error(`扩展目录名不安全: ${name}`);
    if (item.type === 'third-party') return `extensions/third-party/${name}`;
    return `default-user/extensions/${name}`;
}

function isBuiltin(item) { return item.type === 'builtin'; }
function isImportable(item) { return !isBuiltin(item); }

function renderItem(item, index) {
    const builtin = isBuiltin(item);
    const installedLabel = item.existing ? '已安装' : '未安装';
    const status = builtin ? 'TT 内置' : installedLabel;
    return `<label class="stei-item ${builtin ? 'stei-item-skip' : ''}">
        <input type="checkbox" data-stei-index="${index}" ${builtin ? 'disabled' : 'checked'}>
        <div class="stei-item-main">
          <div class="stei-item-top">
            <span class="stei-item-name">${escapeHtml(item.displayName)}</span>
            <span class="stei-badge">${escapeHtml(status)}</span>
            <span class="stei-badge">${escapeHtml(item.type)}</span>
          </div>
          <div class="stei-item-meta">${item.version ? `${escapeHtml(item.version)} · ` : ''}${escapeHtml(item.root)}</div>
          ${builtin ? '<div class="stei-item-warning">TT 已有对应内置扩展，默认不导入。</div>' : ''}
        </div>
    </label>`;
}

function renderList(items) {
    const thirdParty = items.map((x, i) => [x, i]).filter(([x]) => x.type === 'third-party');
    const local = items.map((x, i) => [x, i]).filter(([x]) => x.type !== 'third-party');
    const section = (title, rows) => rows.length
        ? `<div class="stei-section-title">${title} <span class="stei-badge">${rows.length}</span></div>${rows.map(([x,i]) => renderItem(x,i)).join('')}`
        : '';
    $('#stei_list').html(section('第三方扩展', thirdParty) + section('其他 / TT 内置扩展', local));
    const importable = items.some(isImportable);
    $('#stei_actions').toggle(importable);
}

async function getDataRoot() {
    const invoke = getSafeInvoke();
    const paths = await invoke('get_runtime_paths');
    const root = String(paths?.data_root || '').trim();
    if (!root) throw new Error('无法取得 TauriTavern data 目录');
    return root;
}

async function mkdir(path) {
    await fsInvoke('plugin:fs|mkdir', { path, options: { recursive: true } });
}

async function remove(path) {
    try { await fsInvoke('plugin:fs|remove', { path, options: { recursive: true } }); } catch { /* absent is fine */ }
}

async function existsDir(path) {
    try { await getRawInvoke()('plugin:fs|read_dir', { path }); return true; }
    catch { return false; }
}

async function writeFile(path, bytes) {
    const invoke = getRawInvoke();
    await invoke('plugin:fs|write_file', bytes, {
        headers: {
            path: encodeURIComponent(path),
            options: JSON.stringify({ append: false, create: true, truncate: true }),
        },
    });
}

async function importItem(item, zip, dataRoot, overwrite) {
    const targetRoot = `${dataRoot.replace(/[\\/]$/, '')}/${targetRelativeRoot(item)}`;
    if (overwrite) await remove(targetRoot);
    await mkdir(targetRoot);
    for (const entry of item.fileList) {
        if (entry.directory) continue;
        const rel = entry.name.slice(item.root.length).replace(/^\/+/, '');
        if (!rel || isUnsafeZipPath(rel)) throw new Error(`不安全的扩展文件路径: ${entry.name}`);
        const target = `${targetRoot}/${rel}`;
        const parentParts = target.split('/');
        parentParts.pop();
        await mkdir(parentParts.join('/'));
        const bytes = await zip.readEntry(entry);
        await writeFile(target, bytes);
    }
}

async function handlePick(file) {
    if (!file) return;
    selectedFile = file;
    selectedZip = null;
    entries = [];
    $('#stei_list').empty();
    $('#stei_actions, #stei_summary, #stei_result').hide();
    $('#stei_file_name').text(file.name);
    setStatus(`正在扫描：${file.name}`);
    try {
        const result = await scanZip(file);
        selectedZip = result.zip;
        entries = result.extensions;
        const dataRoot = await getDataRoot();
        for (const item of entries) {
            try {
                item.existing = await existsDir(`${dataRoot.replace(/[\\/]$/, '')}/${targetRelativeRoot(item)}`);
            } catch { item.existing = false; }
        }
        renderList(entries);
        const thirdParty = entries.filter(x => x.type === 'third-party').length;
        const builtin = entries.filter(isBuiltin).length;
        const importable = entries.filter(isImportable).length;
        $('#stei_count').text(`共 ${entries.length} 个 · 第三方 ${thirdParty} · 内置 ${builtin}`);
        $('#stei_summary').show();
        $('#stei_rescan').show();
        setStatus(`扫描完成：${importable} 个可导入，${builtin} 个 TT 内置扩展默认跳过。`, true);
    } catch (error) {
        selectedZip = null;
        entries = [];
        setStatus(`扫描失败：${error?.message || error}`);
        window.toastr?.error?.(error?.message || String(error), 'ST Extension Importer');
    }
}

function selectedEntries() {
    return [...document.querySelectorAll('#stei_list input[data-stei-index]:checked')]
        .map(input => entries[Number(input.dataset.steiIndex)])
        .filter(Boolean)
        .filter(isImportable);
}

async function importSelected() {
    const selected = selectedEntries();
    if (!selected.length) return setStatus('没有选择要导入的扩展。');
    if (!selectedZip) return setStatus('请先选择并扫描 ZIP。');

    try {
        const dataRoot = await getDataRoot();
        const existing = selected.filter(item => item.existing);
        let overwrite = false;
        if (existing.length) {
            const names = existing.map(x => x.displayName).join(', ');
            overwrite = window.confirm(`以下扩展已经存在：\n${names}\n\n确定覆盖整个扩展目录吗？`);
            if (!overwrite) return setStatus('已取消覆盖。');
        }

        const results = [];
        for (let i = 0; i < selected.length; i++) {
            const item = selected[i];
            setStatus(`正在导入 ${i + 1}/${selected.length}：${item.displayName}`);
            try {
                await importItem(item, selectedZip, dataRoot, overwrite);
                results.push({ item, ok: true });
            } catch (error) {
                results.push({ item, ok: false, error: error?.message || String(error) });
            }
        }

        const ok = results.filter(x => x.ok).length;
        const fail = results.length - ok;
        const lines = results.map(x => `${x.ok ? '✓' : '✕'} ${x.item.displayName}${x.ok ? '' : `：${x.error}`}`);
        $('#stei_result').html(`<div class="stei-result-title">导入结果</div>${escapeHtml(lines.join('\n'))}`).show();
        setStatus(`导入完成：成功 ${ok} 个，失败 ${fail} 个。${ok ? '建议重新加载 TT，让新扩展被发现。' : ''}`);
        if (ok) window.toastr?.success?.(`ST 扩展导入完成：${ok} 个`, 'ST Extension Importer');
        if (fail) window.toastr?.error?.(`有 ${fail} 个扩展导入失败`, 'ST Extension Importer');
    } catch (error) {
        setStatus(`导入失败：${error?.message || error}`);
        window.toastr?.error?.(error?.message || String(error), 'ST Extension Importer');
    }
}

function selectAll(value) {
    document.querySelectorAll('#stei_list input[data-stei-index]:not(:disabled)').forEach(input => input.checked = value);
}

async function init() {
    const html = await renderExtensionTemplateAsync(EXTENSION_NAME, 'settings');
    const $container = $('<div></div>').attr('id', 'st_extension_importer_settings').html(html);
    $('#extensions_settings').append($container);

    $('#stei_pick').on('click', () => $('#stei_file_input').trigger('click'));
    $('#stei_rescan').on('click', () => selectedFile && handlePick(selectedFile));
    $('#stei_select_all').on('click', () => selectAll(true));
    $('#stei_select_none').on('click', () => selectAll(false));
    $('#stei_import').on('click', importSelected);
    $('#stei_file_input').on('change', function () {
        const file = this.files?.[0];
        this.value = '';
        handlePick(file);
    });
}

jQuery(async () => {
    try { await init(); }
    catch (error) { console.error('[ST Extension Importer] init failed', error); }
});
