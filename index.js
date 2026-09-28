import { renderExtensionTemplateAsync } from '../../extensions.js';

const EXTENSION_NAME = 'st-extension-importer';
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
const MAX_TOTAL_UNCOMPRESSED = 2 * 1024 * 1024 * 1024;
const MAX_FILES = 10000;

let entries = [];
let selectedFile = null;

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

function setStatus(text) {
    $('#stei_status').text(String(text || ''));
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

function stripCommonPrefix(paths) {
    const clean = paths.filter(Boolean);
    if (!clean.length) return { prefix: '', paths: clean };
    const first = clean[0].split('/');
    let common = first.length > 1 ? first[0] : '';
    if (!common) return { prefix: '', paths: clean };
    for (const p of clean) {
        if (!p.startsWith(`${common}/`)) return { prefix: '', paths: clean };
    }
    return { prefix: `${common}/`, paths: clean.map(p => p.slice(common.length + 1)) };
}

async function scanZip(file) {
    const zip = await parseZip(await file.arrayBuffer());
    const names = zip.entries.map(e => e.name).filter(Boolean);
    const normalized = stripCommonPrefix(names);
    const mapped = zip.entries.map(e => ({ ...e, name: normalized.prefix && e.name.startsWith(normalized.prefix) ? e.name.slice(normalized.prefix.length) : e.name }));

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
        try {
            const bytes = await zip.readEntry({ ...manifest, name: manifest.name });
            meta = JSON.parse(new TextDecoder().decode(bytes));
        } catch { /* malformed manifest is shown as unknown */ }

        const rootParts = root.split('/');
        const isThirdParty = rootParts.includes('third-party');
        const type = isThirdParty ? 'third-party' : 'local';
        const displayName = String(meta.display_name || meta.displayName || rootParts.at(-1) || root);
        const rootPrefix = `${root}/`;
        const fileList = mapped.filter(e => e.name === root || e.name.startsWith(rootPrefix));
        found.push({ root, type, displayName, version: String(meta.version || ''), meta, fileList });
    }

    // Fallback for extension folders without manifest.json.
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
        if (parts[0] !== 'third-party' && parts[0] !== 'extensions') continue;
        const isThirdParty = parts.includes('third-party');
        found.push({ root, type: isThirdParty ? 'third-party' : 'local', displayName: parts.at(-1), version: '', meta: {}, fileList });
    }

    if (!found.length) throw new Error('没有找到可识别的 SillyTavern 扩展目录');
    return { zip, extensions: found };
}

function targetRelativeRoot(item) {
    const name = item.root.split('/').filter(Boolean).at(-1);
    if (!name || !/^[A-Za-z0-9._-]+$/.test(name)) throw new Error(`扩展目录名不安全: ${name}`);
    return item.type === 'third-party'
        ? `extensions/third-party/${name}`
        : `default-user/extensions/${name}`;
}

function renderList(items) {
    const html = items.map((item, index) => {
        const skip = item.type === 'local' && ['memory','regex','quick-reply','tts','vectors','token-counter','caption','attachments','assets','gallery','connection-manager','expressions','stable-diffusion','translate','code-render','data-migration','tauritavern-version','agent-system','mcp-manager'].includes(item.root.split('/').at(-1));
        return `<label class="stei-item ${skip ? 'stei-item-skip' : ''}">
            <input type="checkbox" data-stei-index="${index}" ${skip ? '' : 'checked'} ${skip ? 'disabled' : ''}>
            <div class="stei-item-main"><div class="stei-item-name">${escapeHtml(item.displayName)}</div><div class="stei-item-meta">${escapeHtml(item.type)}${item.version ? ` · ${escapeHtml(item.version)}` : ''} · ${escapeHtml(item.root)}</div></div>
        </label>`;
    }).join('');
    $('#stei_list').html(html);
    $('#stei_actions').toggle(items.some(item => !(item.type === 'local' && ['memory','regex','quick-reply','tts','vectors','token-counter','caption','attachments','assets','gallery','connection-manager','expressions','stable-diffusion','translate','code-render','data-migration','tauritavern-version','agent-system','mcp-manager'].includes(item.root.split('/').at(-1)))));
}

function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, ch => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[ch]));
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
    try { await fsInvoke('plugin:fs|remove', { path, options: { recursive: true } }); } catch { /* not found is fine */ }
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
    setStatus(`正在扫描：${file.name}`);
    $('#stei_list').empty();
    $('#stei_actions').hide();
    try {
        const result = await scanZip(file);
        entries = result.extensions;
        renderList(entries);
        const thirdParty = entries.filter(x => x.type === 'third-party').length;
        setStatus(`发现 ${entries.length} 个扩展，其中 ${thirdParty} 个 third-party。TT 内置扩展会默认跳过。`);
        $('#stei_import').off('click').on('click', () => importSelected(result.zip));
    } catch (error) {
        entries = [];
        setStatus(`扫描失败：${error?.message || error}`);
    }
}

async function importSelected(zip) {
    const selected = [...document.querySelectorAll('#stei_list input[data-stei-index]:checked')]
        .map(input => entries[Number(input.dataset.steiIndex)])
        .filter(Boolean);
    if (!selected.length) return setStatus('没有选择要导入的扩展。');

    try {
        const dataRoot = await getDataRoot();
        const existing = [];
        for (const item of selected) {
            const target = `${dataRoot.replace(/[\\/]$/, '')}/${targetRelativeRoot(item)}`;
            try {
                await getRawInvoke()('plugin:fs|read_dir', { path: target });
                existing.push(item);
            } catch { /* does not exist */ }
        }
        let overwrite = false;
        if (existing.length) {
            const names = existing.map(x => x.displayName).join(', ');
            overwrite = window.confirm(`以下扩展已经存在：\n${names}\n\n确定覆盖整个扩展目录吗？`);
            if (!overwrite) {
                setStatus('已取消覆盖。');
                return;
            }
        }

        for (let i = 0; i < selected.length; i++) {
            const item = selected[i];
            setStatus(`正在导入 ${i + 1}/${selected.length}：${item.displayName}`);
            await importItem(item, zip, dataRoot, overwrite);
        }
        setStatus(`导入完成：${selected.length} 个扩展。\n建议重新加载页面，让新扩展被发现。`);
        window.toastr?.success?.(`ST 扩展导入完成：${selected.length} 个`);
    } catch (error) {
        setStatus(`导入失败：${error?.message || error}`);
        window.toastr?.error?.(error?.message || String(error), 'ST Extension Importer');
    }
}

async function init() {
    const html = await renderExtensionTemplateAsync(EXTENSION_NAME, 'settings');
    const $container = $('<div></div>').attr('id', 'st_extension_importer_settings').html(html);
    $('#extensions_settings').append($container);

    $('#stei_pick').on('click', () => $('#stei_file_input').trigger('click'));
    $('<input type="file" id="stei_file_input" accept=".zip,application/zip" style="display:none">')
        .appendTo($container)
        .on('change', function () {
            const file = this.files?.[0];
            this.value = '';
            handlePick(file);
        });
}

jQuery(async () => {
    try {
        await init();
    } catch (error) {
        console.error('[ST Extension Importer] init failed', error);
    }
});
