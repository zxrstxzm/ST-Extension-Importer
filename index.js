import { renderExtensionTemplateAsync } from '../../../extensions.js';

const EXTENSION_NAME = 'third-party/ST-Extension-Importer';
const VERSION = '0.7.3';
const MAX_ARCHIVE_BYTES = 1000 * 1024 * 1024;
const MAX_TOTAL_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_TOTAL_UNCOMPRESSED = 2 * 1024 * 1024 * 1024;
const MAX_FILES = 100000;

const BUILTIN_NAMES = new Set([
    'memory', 'regex', 'quick-reply', 'tts', 'vectors', 'token-counter', 'caption',
    'attachments', 'assets', 'gallery', 'connection-manager', 'expressions',
    'stable-diffusion', 'translate', 'code-render', 'data-migration',
    'tauritavern-version', 'agent-system', 'mcp-manager',
]);

let entries = [];
let selectedFiles = [];
let selectedZips = [];
let selectedFolderPath = '';

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
    if (bytes.byteLength > MAX_ARCHIVE_BYTES) throw new Error('ZIP 超过 1000 MB 限制');
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const eocd = findEndOfCentralDirectory(bytes);
    const count = readU16(view, eocd + 10);
    const centralSize = readU32(view, eocd + 12);
    const centralOffset = readU32(view, eocd + 16);
    if (count > MAX_FILES) throw new Error(`ZIP 文件数量超过 ${MAX_FILES}（当前版本上限）`);
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

function isValidExtensionManifest(meta) {
    if (!meta || typeof meta !== 'object') return false;
    const displayName = meta.display_name ?? meta.displayName;
    const js = meta.js;
    // SillyTavern UI extensions are identified by a manifest with a display name
    // and a JS entry point. Do not infer extensions from arbitrary directories.
    return typeof displayName === 'string' && displayName.trim().length > 0
        && typeof js === 'string' && js.trim().length > 0;
}

function isIgnoredPath(path) {
    const parts = String(path || '').split('/').filter(Boolean).map(x => x.toLowerCase());
    return parts.includes('.git') || parts.includes('node_modules');
}

function findExplicitThirdPartyRoot(names) {
    const normalized = names.map(x => String(x).replace(/\\/g, '/'));
    const candidates = [
        'public/scripts/extensions/third-party/',
        'scripts/extensions/third-party/',
        'extensions/third-party/',
        'third-party/',
    ];
    for (const candidate of candidates) {
        if (normalized.some(name => name.startsWith(candidate))) return candidate;
    }
    return '';
}

function makeMappedEntries(zipEntries) {
    const names = zipEntries.map(e => e.name).filter(Boolean);
    const prefix = findExplicitThirdPartyRoot(names);
    if (!prefix) return zipEntries;
    return zipEntries
        .filter(e => !isIgnoredPath(e.name))
        .filter(e => e.name.startsWith(prefix))
        .map(e => ({ ...e, name: e.name.slice(prefix.length) }))
        .filter(e => e.name);
}

async function readZipManifest(zip, entry) {
    try {
        const raw = await zip.readEntry(entry);
        return JSON.parse(new TextDecoder().decode(raw));
    } catch {
        return null;
    }
}

function rootForManifestName(name) {
    const normalized = String(name || '').replace(/\\/g, '/');
    if (!normalized.toLowerCase().endsWith('/manifest.json') && normalized.toLowerCase() !== 'manifest.json') return null;
    return normalized.toLowerCase() === 'manifest.json'
        ? ''
        : normalized.slice(0, normalized.length - 'manifest.json'.length);
}

async function scanZip(file) {
    const zip = await parseZip(await file.arrayBuffer());
    const found = [];
    const allEntries = zip.entries.filter(e => e.name && !isIgnoredPath(e.name));
    const allNames = allEntries.map(e => e.name);

    // 1. Normal ST layout: third-party/<extension>/manifest.json (or full public/scripts path).
    const explicitPrefix = findExplicitThirdPartyRoot(allNames);
    let mapped = explicitPrefix
        ? allEntries
            .filter(e => e.name.startsWith(explicitPrefix))
            .map(e => ({ ...e, name: e.name.slice(explicitPrefix.length) }))
            .filter(e => e.name)
        : allEntries;

    // 2. A single extension repository ZIP, e.g. GitHub's cocktail-plus-main.zip.
    //    The repository root itself contains manifest.json. This is a valid ST
    //    extension package; do NOT treat .git/src/dist/server-plugins as separate extensions.
    if (!explicitPrefix) {
        const manifestCandidates = allEntries.filter(e => !e.directory && /(^|\/)manifest\.json$/i.test(e.name));
        const rootManifests = [];
        for (const manifest of manifestCandidates) {
            const root = rootForManifestName(manifest.name);
            if (root === null) continue;
            const meta = await readZipManifest(zip, manifest);
            if (!isValidExtensionManifest(meta)) continue;
            rootManifests.push({ manifest, root, meta });
        }

        if (rootManifests.length === 1) {
            const { root, meta } = rootManifests[0];
            const normalizedRoot = root;
            const fileList = allEntries
                .filter(e => e.name.startsWith(normalizedRoot) && !isIgnoredPath(e.name))
                .map(e => ({ ...e, name: e.name.slice(normalizedRoot.length) }))
                .filter(e => e.name);
            const name = normalizedRoot.replace(/\/$/, '').split('/').filter(Boolean).at(-1) || String(meta.display_name || 'extension');
            return {
                zip,
                extensions: [{
                    root: name,
                    sourceRoot: normalizedRoot,
                    type: 'third-party',
                    displayName: String(meta.display_name || meta.displayName || name),
                    version: String(meta.version || ''),
                    meta,
                    fileList,
                    repoPackage: true,
                    hasServerPlugin: allEntries.some(e => e.name.startsWith(`${normalizedRoot}server-plugins/`)),
                }],
            };
        }
    }

    // Normal third-party collection:
    // treat ONLY direct child folders as extension candidates. A manifest.json
    // is optional. This mirrors the folder scanner and avoids mistaking
    // nested src/dist/scripts/server-plugins/.git directories for extensions.
    mapped = mapped.filter(e => !isIgnoredPath(e.name));

    const IGNORE_DIRS = new Set([
        '.git', '.github', '.idea', '.vscode',
        'node_modules', 'src', 'dist', 'scripts', 'server-plugins',
        'build', 'coverage', 'test', 'tests',
    ]);

    function ignoredCandidate(name) {
        const lower = String(name || '').trim().toLowerCase();
        if (!lower || lower === '.' || lower === '..') return true;
        if (lower.startsWith('.')) return true;
        if (IGNORE_DIRS.has(lower)) return true;
        if (lower.includes('backup') || lower.includes('backups')) return true;
        if (lower.endsWith('-backup') || lower.endsWith('_backup')) return true;
        return false;
    }

    // Collect first path component, i.e. direct children of third-party/.
    // Directory entries are not guaranteed to exist in every ZIP, so infer
    // directories from file paths as well.
    const roots = new Set();
    for (const entry of mapped) {
        const parts = entry.name.split('/').filter(Boolean);
        if (parts.length >= 2 && !ignoredCandidate(parts[0])) roots.add(parts[0]);
    }

    for (const root of roots) {
        const fileList = mapped.filter(e => e.name === root || e.name.startsWith(`${root}/`));
        const manifest = fileList.find(e => !e.directory && e.name.toLowerCase() === `${root.toLowerCase()}/manifest.json`);

        let meta = {};
        if (manifest) {
            meta = await readZipManifest(zip, manifest) || {};
        }

        const hasUsefulFile = fileList.some(e =>
            !e.directory && /\.(?:js|mjs|cjs|html?|css|json|wasm)$/i.test(e.name)
        );
        if (!fileList.some(e => !e.directory) || !hasUsefulFile) continue;

        found.push({
            root,
            type: 'third-party',
            displayName: String(meta.display_name || meta.displayName || root),
            version: String(meta.version || ''),
            meta,
            fileList,
            hasManifest: Boolean(manifest),
            sourceFolder: false,
        });
    }

    // A ZIP containing a single extension's files directly at its root
    // (without third-party/<name>/) is also accepted. It is still treated as
    // one extension, and the ZIP filename is used as the fallback directory name.
    if (!found.length) {
        const rootFiles = mapped.filter(e => !e.directory && e.name);
        const manifest = rootFiles.find(e => e.name.toLowerCase() === 'manifest.json');
        let meta = {};
        if (manifest) meta = await readZipManifest(zip, manifest) || {};

        const hasUsefulFile = rootFiles.some(e =>
            /\.(?:js|mjs|cjs|html?|css|json|wasm)$/i.test(e.name)
        );

        if (hasUsefulFile) {
            const fallbackName = String(file.name || 'extension.zip')
                .replace(/\.zip$/i, '')
                .replace(/[^A-Za-z0-9._-]+/g, '-')
                .replace(/^-+|-+$/g, '') || 'extension';

            found.push({
                root: fallbackName,
                type: 'third-party',
                displayName: String(meta.display_name || meta.displayName || fallbackName),
                version: String(meta.version || ''),
                meta,
                fileList: rootFiles,
                hasManifest: Boolean(manifest),
                sourceFolder: false,
            });
        }
    }

    if (!found.length) {
        throw new Error('没有找到符合 SillyTavern manifest.json 规范的第三方扩展。不会把 .git、src、dist、scripts、server-plugins 等普通目录误识别为扩展。');
    }
    return { zip, extensions: found };
}

function targetRelativeRoot(item) {
    const name = item.root.split('/').filter(Boolean).at(-1);
    if (!name || !/^[A-Za-z0-9._-]+$/.test(name)) throw new Error(`扩展目录名不安全: ${name}`);
    if (item.type !== 'third-party') throw new Error(`暂不导入非第三方扩展：${name}`);
    return name;
}

function isBuiltin(item) { return item.type === 'builtin'; }
function isImportable(item) { return item.type === 'third-party'; }
function extensionFolderKey(item) {
    return String(item?.root || '').replace(/\\/g, '/').split('/').filter(Boolean).at(-1)?.toLowerCase() || '';
}

function renderItem(item, index) {
    const builtin = isBuiltin(item);
    const installedLabel = item.existing ? '已安装' : '未安装';
    const status = builtin ? 'TT 内置' : installedLabel;
    return `<label class="stei-item ${builtin ? 'stei-item-skip' : ''}">
        <input type="checkbox" data-stei-index="${index}" ${(builtin || item.empty || item.unreadable || !item.fileList?.length) ? 'disabled' : 'checked'}>
        <div class="stei-item-main">
          <div class="stei-item-top">
            <span class="stei-item-name">${escapeHtml(item.displayName)}</span>
            <span class="stei-badge">${escapeHtml(status)}</span>
            <span class="stei-badge">${escapeHtml(item.type)}</span>
          </div>
          <div class="stei-item-meta">${item.version ? `${escapeHtml(item.version)} · ` : ''}${escapeHtml(item.root)}</div>
          ${builtin ? '<div class="stei-item-warning">TT 已有对应内置扩展，默认不导入。</div>' : ''}${item.sourceFolder && !item.hasManifest ? '<div class="stei-item-warning">未发现 manifest.json，但它位于 third-party 的直接子目录中，将按扩展目录迁移。</div>' : ''}${item.empty ? '<div class="stei-item-warning">目录为空，无法导入。</div>' : ''}${item.unreadable ? `<div class="stei-item-warning">无法读取：${escapeHtml(item.scanError || '未知错误')}</div>` : ''}${item.repoPackage && item.hasServerPlugin ? '<div class="stei-item-warning">此仓库同时包含 Server Plugin；当前仅迁移前端扩展文件，后端插件不会被放进 third-party 目录。</div>' : ''}
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

function normalizeFsPath(path) {
    return String(path || '').replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '');
}

function getThirdPartyRootFromExtensionPath(path) {
    const p = normalizeFsPath(path);
    const lower = p.toLowerCase();
    const marker = '/extensions/third-party/';
    const i = lower.indexOf(marker);
    if (i >= 0) return p.slice(0, i + marker.length - 1);
    // Some TT builds expose a path with a literal third-party segment but a
    // slightly different prefix. Use the nearest ancestor named third-party.
    const parts = p.split('/').filter(Boolean);
    const n = parts.map(x => x.toLowerCase()).lastIndexOf('third-party');
    if (n >= 0) return '/' + parts.slice(0, n + 1).join('/');
    return '';
}

function collectInstalledExtensionNames(list) {
    const installed = new Set();
    for (const item of list) {
        for (const value of [item?.name, item?.path, item?.folder, item?.directory]) {
            const p = normalizeFsPath(value);
            if (!p) continue;
            const parts = p.split('/').filter(Boolean);
            // The extension API may return either "third-party/foo" or an
            // absolute path ending in "/third-party/foo[/index.js]".
            const tp = parts.map(x => x.toLowerCase()).lastIndexOf('third-party');
            if (tp >= 0 && parts[tp + 1]) installed.add(parts[tp + 1].toLowerCase());
            if (parts.length) {
                const last = parts.at(-1);
                if (last && !/\.(?:js|mjs|cjs|json|css|html?)$/i.test(last)) {
                    installed.add(last.toLowerCase());
                }
            }
        }
    }
    return installed;
}

async function getInstallContext() {
    const invoke = getSafeInvoke();
    const list = await invoke('get_extensions');
    if (!Array.isArray(list)) throw new Error('无法取得 TauriTavern 扩展列表');

    const self = list.find(item => {
        const values = [item?.name, item?.path, item?.folder].map(x => normalizeFsPath(x).toLowerCase());
        return values.some(x => x === 'st-extension-importer' || x.endsWith('/st-extension-importer') || x.endsWith('/st-extension-importer/index.js'));
    });
    const extensionPath = String(self?.path || self?.folder || '').trim();
    if (!extensionPath) {
        throw new Error('无法定位 ST Extension Importer 的安装目录，请重新加载扩展后再试');
    }

    const thirdPartyRoot = getThirdPartyRootFromExtensionPath(extensionPath);
    if (!thirdPartyRoot) {
        throw new Error('无法确定 TT 的 third-party 安装目录。请确认迁移器本身是安装在 data/extensions/third-party/ST-Extension-Importer。');
    }

    return {
        baseDir: thirdPartyRoot,
        installedThirdParty: collectInstalledExtensionNames(list),
        extensions: list,
        self,
    };
}

async function getInstallBaseDir() {
    return (await getInstallContext()).baseDir;
}

async function mkdir(path) {
    await fsInvoke('plugin:fs|mkdir', { path, options: { recursive: true } });
}

async function remove(path) {
    try { await fsInvoke('plugin:fs|remove', { path, options: { recursive: true } }); } catch { /* absent is fine */ }
}

async function existsDir(path) {
    try {
        const result = await getRawInvoke()('plugin:fs|read_dir', { path });
        return Array.isArray(result) || Array.isArray(result?.entries) || Array.isArray(result?.children);
    } catch { return false; }
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

function safeZipRelativePath(item, entry) {
    const raw = String(entry?.name || '').replace(/\\/g, '/');
    if (!raw) throw new Error('ZIP 条目没有文件名');

    // scanZip() stores normal collection entries as:
    //   extension-name/path/to/file
    // and repoPackage entries as paths relative to the repository root.
    // Never use a blind string slice here: if the prefix is not exactly what
    // we expect, it can turn a perfectly valid path into a malformed one.
    let rel;
    if (item.repoPackage) {
        rel = raw.replace(/^\/+/, '');
    } else {
        const root = String(item.root || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
        const prefix = root ? `${root}/` : '';
        if (!prefix || raw === root) {
            throw new Error(`扩展文件路径缺少扩展目录前缀: ${raw}`);
        }
        if (!raw.startsWith(prefix)) {
            throw new Error(`扩展文件路径不属于 ${root}: ${raw}`);
        }
        rel = raw.slice(prefix.length);
    }

    rel = rel.replace(/^\/+/, '');
    const parts = rel.split('/');
    if (!rel || parts.some(part => !part || part === '.' || part === '..') || /^[A-Za-z]:[\\/]/.test(rel)) {
        throw new Error(`不安全的扩展文件路径: ${entry.name}`);
    }
    return rel;
}

async function importItem(item, zip, dataRoot, overwrite) {
    const targetRoot = `${dataRoot.replace(/[\\/]$/, '')}/${targetRelativeRoot(item)}`;
    if (overwrite) await remove(targetRoot);
    await mkdir(targetRoot);
    for (const entry of item.fileList) {
        if (entry.directory) continue;
        const rel = safeZipRelativePath(item, entry);
        const target = `${targetRoot}/${rel}`;
        const parentParts = target.split('/');
        parentParts.pop();
        await mkdir(parentParts.join('/'));
        const bytes = await zip.readEntry(entry);
        await writeFile(target, bytes);
    }
}

async function importFolderItem(item, dataRoot, overwrite) {
    const targetRoot = `${dataRoot.replace(/[\\/]$/, '')}/${targetRelativeRoot(item)}`;
    if (overwrite) await remove(targetRoot);
    await mkdir(targetRoot);

    const sourceRoot = normalizeFsPath(item.sourceExtensionRoot || item.sourceFile || '');
    if (!sourceRoot) throw new Error(`无法确定源扩展目录: ${item.root}`);

    for (const entry of item.fileList) {
        if (entry.directory) continue;

        // walkFs() already records each file name relative to sourceExtensionRoot.
        // On Android, plugin:fs may return child.path in a different representation
        // (for example a normalized/URI-like path), so comparing that absolute path
        // with sourceRoot can falsely reject every file as "unsafe".
        // Security validation therefore uses the trusted relative path produced by
        // our own directory traversal, while the actual entry.path is used only to
        // read the bytes.
        const rel = String(entry.name || '').replace(/\\/g, '/').replace(/^\/+/, '');
        const parts = rel.split('/');
        if (!rel || rel.startsWith('/') || parts.some(part => !part || part === '.' || part === '..') || /^[A-Za-z]:[\\/]/.test(rel)) {
            throw new Error(`不安全的扩展文件路径: ${entry.name || entry.path || item.root}`);
        }

        const target = `${targetRoot}/${rel}`;
        const parentParts = target.split('/');
        parentParts.pop();
        await mkdir(parentParts.join('/'));

        const bytes = await readFsFile(entry.path);
        await writeFile(target, bytes);
    }
}


function normalizeFsBytes(value) {
    if (value instanceof Uint8Array) return value;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    if (Array.isArray(value)) return new Uint8Array(value);
    if (value && Array.isArray(value.bytes)) return new Uint8Array(value.bytes);
    if (value && Array.isArray(value.data)) return new Uint8Array(value.data);
    throw new Error('文件读取结果格式无法识别');
}

async function readFsFile(path) {
    const value = await getRawInvoke()('plugin:fs|read_file', { path });
    return normalizeFsBytes(value);
}

function joinFsPath(root, name) {
    const a = String(root || '').replace(/[\\/]+$/, '');
    const b = String(name || '').replace(/^[\\/]+/, '');
    return `${a}/${b}`;
}

function basenamePath(path) {
    return String(path || '').split(/[\\/]/).filter(Boolean).at(-1) || '';
}

async function readFsDir(path) {
    const result = await getRawInvoke()('plugin:fs|read_dir', { path });
    if (!Array.isArray(result)) return [];
    return result;
}

async function walkFs(root, relative = '', out = []) {
    const current = relative ? joinFsPath(root, relative) : root;
    const children = await readFsDir(current);
    for (const child of children) {
        // Android/Tauri 的 read_dir 在不同版本可能把 name 返回成完整路径或 URI。
        // name 只允许作为一个路径段；真实 child.path 仅用于读取文件。
        const rawName = String(child?.name || '').trim();
        const rawPath = String(child?.path || '').trim();
        const name = basenamePath(rawName || rawPath).trim();
        if (!name || name === '.' || name === '..' || name.includes('\0')) continue;
        if (name.includes('/') || name.includes('\\')) continue;
        const rel = relative ? `${relative}/${name}` : name;
        const childPath = rawPath || joinFsPath(current, name);
        let isDir = Boolean(
            child?.isDirectory ?? child?.is_dir ?? child?.is_directory ??
            child?.directory ?? child?.children
        );

        // Android/TT 某些 fs 返回值不带 isDirectory。以 read_dir 成功作为第二判断，
        // 避免把整个插件目录名（例如 st-acu-visualizer）当成一个“文件”导入。
        if (!isDir) {
            try {
                const probe = await readFsDir(childPath);
                isDir = Array.isArray(probe);
            } catch { /* 普通文件，继续 */ }
        }

        if (isDir) {
            const lower = name.toLowerCase();
            if (lower === 'node_modules' || lower === '.git') continue;
            await walkFs(root, rel, out);
        } else {
            out.push({ name: rel, path: childPath, directory: false });
        }
    }
    return out;
}

function findFolderExtensionsRoot(names) {
    const normalized = names.map(x => String(x).replace(/\\/g, '/').replace(/^\/+/, ''));
    const targets = [
        'public/scripts/extensions/third-party/',
        'scripts/extensions/third-party/',
        'extensions/third-party/',
        'third-party/',
    ];
    for (const target of targets) {
        if (normalized.some(name => name === target.slice(0, -1) || name.startsWith(target))) return target;
    }
    return '';
}

function makeFolderMappedEntries(files, rootPrefix) {
    return files
        .filter(e => !e.directory)
        .filter(e => !rootPrefix || e.name.replace(/\\/g, '/').startsWith(rootPrefix))
        .map(e => ({ ...e, name: rootPrefix ? e.name.replace(/\\/g, '/').slice(rootPrefix.length) : e.name.replace(/\\/g, '/') }))
        .filter(e => e.name);
}

async function scanFolder(selectedPath) {
    const rootPath = String(selectedPath || '').trim();
    if (!rootPath) throw new Error('没有选择文件夹');
    setStatus('正在读取 SillyTavern third-party 目录…');

    // We deliberately identify extensions by their DIRECT child directory under
    // third-party, not by manifest.json. Many real SillyTavern third-party
    // extensions do not ship a manifest.json. Nested folders such as
    // src/dist/scripts/server-plugins therefore cannot become separate extensions.
    const children = await readFsDir(rootPath);
    if (!Array.isArray(children) || !children.length) {
        throw new Error('third-party 文件夹为空或无法读取');
    }

    const IGNORE_DIRS = new Set([
        '.git', '.github', '.idea', '.vscode',
        'node_modules', 'src', 'dist', 'scripts', 'server-plugins',
        'build', 'coverage', 'test', 'tests',
    ]);

    function isIgnoredExtensionDir(name) {
        const lower = String(name || '').trim().toLowerCase();
        if (!lower || lower === '.' || lower === '..') return true;
        if (lower.startsWith('.')) return true;
        if (IGNORE_DIRS.has(lower)) return true;
        // Common backup/cache folders that can sit directly under third-party.
        if (lower.includes('backup') || lower.includes('backups')) return true;
        if (lower.endsWith('-backup') || lower.endsWith('_backup')) return true;
        return false;
    }

    const directDirs = children.filter(child => {
        const name = String(child?.name || basenamePath(child?.path) || '').trim();
        const isDir = Boolean(child?.isDirectory ?? child?.is_dir ?? child?.children);
        return isDir && !isIgnoredExtensionDir(name);
    });

    if (!directDirs.length) {
        throw new Error('third-party 目录中没有找到可迁移的扩展文件夹');
    }

    const found = [];
    for (const dir of directDirs) {
        const name = String(dir?.name || basenamePath(dir?.path) || '').trim();
        const extensionRoot = dir?.path || joinFsPath(rootPath, name);

        let files = [];
        try {
            files = await walkFs(extensionRoot);
        } catch (error) {
            // A directory we cannot read is still shown, but cannot be imported.
            found.push({
                root: name,
                type: 'third-party',
                displayName: name,
                version: '',
                meta: {},
                fileList: [],
                sourceFile: rootPath,
                sourceExtensionRoot: extensionRoot,
                sourceFolder: true,
                unreadable: true,
                scanError: error?.message || String(error),
            });
            continue;
        }

        if (!files.length) {
            // Empty extension folders are shown but disabled by import logic/UI.
            found.push({
                root: name,
                type: 'third-party',
                displayName: name,
                version: '',
                meta: {},
                fileList: [],
                sourceFile: rootPath,
                sourceExtensionRoot: extensionRoot,
                sourceFolder: true,
                empty: true,
            });
            continue;
        }

        const normalizedFiles = files.map(e => ({
            ...e,
            name: String(e.name || '').replace(/\\/g, '/'),
        }));

        // manifest.json is optional. If present and valid, use its metadata.
        const manifest = normalizedFiles.find(e => e.name.toLowerCase() === 'manifest.json');
        let meta = {};
        if (manifest) {
            try {
                meta = JSON.parse(new TextDecoder().decode(await readFsFile(manifest.path)));
            } catch { /* metadata is optional; keep folder as candidate */ }
        }

        found.push({
            root: name,
            type: 'third-party',
            displayName: String(meta.display_name || meta.displayName || name),
            version: String(meta.version || ''),
            meta,
            fileList: normalizedFiles,
            sourceFile: rootPath,
            sourceFolder: true,
            hasManifest: Boolean(manifest),
            hasJs: normalizedFiles.some(e => /\.(?:js|mjs|cjs)$/i.test(e.name)),
            hasHtml: normalizedFiles.some(e => /\.(?:html|htm)$/i.test(e.name)),
            hasCss: normalizedFiles.some(e => /\.css$/i.test(e.name)),
        });
    }

    if (!found.length) {
        throw new Error('third-party 目录中没有找到可迁移的扩展文件夹');
    }
    return { extensions: found };
}

async function handlePickFolderPath(path) {
    try {
        entries = [];
        selectedFiles = [];
        selectedZips = [];
        selectedFolderPath = String(path);
        $('#stei_list').empty();
        $('#stei_actions, #stei_summary, #stei_result').hide();
        $('#stei_file_name').text(String(path));
        setStatus('正在扫描文件夹…');

        const result = await scanFolder(path);
        const install = await getInstallContext();
        const seen = new Set();
        for (const item of result.extensions) {
            const key = extensionFolderKey(item);
            if (seen.has(key)) continue;
            seen.add(key);
            item.existing = install.installedThirdParty.has(key);
            entries.push(item);
        }
        renderList(entries);
        $('#stei_count').text(`共 ${entries.length} 个第三方扩展`);
        $('#stei_summary').show();
        $('#stei_rescan').show();
        setStatus(`扫描完成：找到 ${entries.length} 个第三方扩展。`, true);
    } catch (error) {
        entries = [];
        setStatus(`扫描失败：${error?.message || error}`);
        window.toastr?.error?.(error?.message || String(error), 'ST Extension Importer');
    }
}


function dirnamePath(path) {
    const normalized = String(path || '').replace(/\\/g, '/').replace(/\/+$/, '');
    const idx = normalized.lastIndexOf('/');
    return idx > 0 ? normalized.slice(0, idx) : normalized;
}

async function hasFile(path) {
    try {
        const parent = dirnamePath(path);
        const name = basenamePath(path);
        const children = await readFsDir(parent);
        return children.some(child => String(child?.name || basenamePath(child?.path) || '') === name && !(child?.isDirectory ?? child?.is_dir));
    } catch { return false; }
}

async function findExtensionRootFromAnchor(anchorPath) {
    let current = dirnamePath(anchorPath);
    for (let depth = 0; depth < 8 && current; depth++) {
        const base = basenamePath(current).toLowerCase();
        // A manifest at this level is the strongest signal that this is an extension root.
        try {
            const children = await readFsDir(current);
            const hasManifest = children.some(child => {
                const name = String(child?.name || basenamePath(child?.path) || '').toLowerCase();
                const isDir = Boolean(child?.isDirectory ?? child?.is_dir ?? child?.children);
                return !isDir && name === 'manifest.json';
            });
            if (hasManifest) return current;
        } catch { /* keep walking upward */ }

        // If the selected item itself is directly inside third-party/<extension>, this is the root.
        const lower = current.replace(/\\/g, '/').toLowerCase();
        if (lower.endsWith('/third-party') || lower.includes('/extensions/third-party/')) {
            return null;
        }
        current = dirnamePath(current);
    }
    return null;
}

async function scanExtensionDirectory(rootPath) {
    const files = await walkFs(rootPath);
    if (!files.length) throw new Error(`无法读取扩展目录：${rootPath}`);
    const normalizedFiles = files.map(e => ({ ...e, name: e.name.replace(/\\/g, '/') }));
    const manifest = normalizedFiles.find(e => e.name.toLowerCase() === 'manifest.json');
    let meta = {};
    if (manifest) {
        try { meta = JSON.parse(new TextDecoder().decode(await readFsFile(manifest.path))); } catch {}
    }
    const name = basenamePath(rootPath);
    if (!name || name === 'third-party') throw new Error(`不是单个第三方扩展目录：${rootPath}`);
    return {
        root: name,
        type: 'third-party',
        displayName: String(meta.display_name || meta.displayName || name),
        version: String(meta.version || ''),
        meta,
        fileList: normalizedFiles,
        sourceFile: rootPath,
        sourceExtensionRoot: rootPath,
        sourceFolder: true,
    };
}

function inferThirdPartyRootFromPath(anchorPath) {
    const normalized = String(anchorPath || '').replace(/\\/g, '/');
    const lower = normalized.toLowerCase();
    const marker = '/extensions/third-party/';
    const idx = lower.indexOf(marker);
    if (idx >= 0) {
        return normalized.slice(0, idx + '/extensions/third-party'.length);
    }

    const marker2 = '/scripts/extensions/third-party/';
    const idx2 = lower.indexOf(marker2);
    if (idx2 >= 0) {
        return normalized.slice(0, idx2 + '/scripts/extensions/third-party'.length);
    }

    const marker3 = '/public/scripts/extensions/third-party/';
    const idx3 = lower.indexOf(marker3);
    if (idx3 >= 0) {
        return normalized.slice(0, idx3 + '/public/scripts/extensions/third-party'.length);
    }

    // If the picker returns a path under a directory literally named third-party,
    // walk upward until that directory is found.
    let current = normalized;
    for (let i = 0; i < 12 && current; i++) {
        if (basenamePath(current).toLowerCase() === 'third-party') return current;
        current = dirnamePath(current);
    }
    return '';
}

async function handlePickExtensionFiles() {
    try {
        const picked = await getSafeInvoke()('plugin:dialog|open', {
            options: {
                title: '选择 ST 第三方扩展中的任意文件',
                multiple: true,
                directory: false,
                filters: [{
                    name: '扩展文件',
                    extensions: [
                        'js', 'json', 'css', 'html', 'htm',
                        'png', 'jpg', 'jpeg', 'webp', 'gif', 'svg',
                        'wasm', 'mjs', 'cjs', 'ts', 'txt', 'md'
                    ],
                }],
            },
        });

        const paths = (Array.isArray(picked) ? picked : [picked])
            .filter(Boolean)
            .map(String);

        if (!paths.length) return;

        entries = [];
        selectedFiles = [];
        selectedZips = [];
        selectedFolderPath = '';
        $('#stei_list').empty();
        $('#stei_actions, #stei_summary, #stei_result').hide();
        $('#stei_file_name').text(`已选择 ${paths.length} 个文件`);
        setStatus('正在自动定位 third-party 并扫描全部第三方扩展…');

        // 关键：用户只需要在 third-party 里面选一个文件。
        // 不要求 Android Folder Picker，也不要求每个插件各选一个文件。
        const roots = new Map();
        for (const path of paths) {
            const root = inferThirdPartyRootFromPath(path);
            if (root) roots.set(root.replace(/\\/g, '/').toLowerCase(), root);
        }

        if (!roots.size) {
            throw new Error(
                '无法定位 third-party 目录。请在 SillyTavern/public/scripts/extensions/third-party/ 内任意插件中选择一个文件（推荐 manifest.json）。'
            );
        }

        const install = await getInstallContext();
        const dataRoot = install.baseDir;
        const all = [];
        const seen = new Set();
        let duplicateCount = 0;

        for (const root of roots.values()) {
            setStatus(`正在扫描：${root}`);
            const result = await scanFolder(root);

            for (const item of result.extensions) {
                const key = (item.root.split('/').filter(Boolean).at(-1) || item.root).toLowerCase();
                if (seen.has(key)) {
                    duplicateCount++;
                    continue;
                }
                seen.add(key);
                item.sourceFile = root;
                item.sourceFolder = true;
                item.existing = install.installedThirdParty.has(key);
                all.push(item);
            }
        }

        entries = all;

        if (!entries.length) {
            throw new Error('third-party 目录中没有找到可迁移的扩展文件夹。');
        }

        renderList(entries);
        $('#stei_count').text(
            `共 ${entries.length} 个第三方扩展${duplicateCount ? ` · 自动去重 ${duplicateCount} 个` : ''}`
        );
        $('#stei_summary').show();
        $('#stei_rescan').show();
        setStatus(
            `扫描完成：自动发现 ${entries.length} 个第三方扩展。无需逐个选择插件。`,
            true
        );
    } catch (error) {
        entries = [];
        setStatus(`扫描失败：${error?.message || error}`);
        window.toastr?.error?.(error?.message || String(error), 'ST Extension Importer');
    }
}

async function handlePickFolder() {
    try {
        const picked = await getSafeInvoke()('plugin:dialog|open', {
            options: { title: '选择 SillyTavern 文件夹', multiple: false, directory: true, recursive: false },
        });
        const path = Array.isArray(picked) ? picked[0] : picked;
        if (!path) return;
        await handlePickFolderPath(path);
    } catch (error) {
        setStatus(`选择文件夹失败：${error?.message || error}`);
        window.toastr?.error?.(error?.message || String(error), 'ST Extension Importer');
    }
}

async function handlePick(files) {
    const list = [...(files || [])]
        .filter(Boolean)
        .filter(file => {
            const name = String(file.name || '').toLowerCase();
            return name.endsWith('.zip') || file.type === 'application/zip' || file.type === 'application/x-zip-compressed';
        });
    if (!list.length) {
        setStatus('没有选择 ZIP 文件。');
        return;
    }

    selectedFiles = list;
    selectedZips = [];
    selectedFolderPath = '';
    entries = [];
    $('#stei_list').empty();
    $('#stei_actions, #stei_summary, #stei_result').hide();
    $('#stei_file_name').text(list.length === 1 ? list[0].name : `${list.length} 个 ZIP`);
    setStatus(`正在扫描 ${list.length} 个 ZIP…`);

    try {
        const totalBytes = list.reduce((sum, file) => sum + (file.size || 0), 0);
        if (totalBytes > MAX_TOTAL_ARCHIVE_BYTES) {
            throw new Error('本次选择的 ZIP 总大小超过 2 GB，请分批添加。');
        }

        const all = [];
        const seen = new Map();
        let duplicateCount = 0;

        for (let i = 0; i < list.length; i++) {
            const file = list[i];
            setStatus(`正在扫描 ${i + 1}/${list.length}：${file.name}`);
            const result = await scanZip(file);
            selectedZips.push({ file, zip: result.zip });

            for (const item of result.extensions) {
                const key = item.root.split('/').filter(Boolean).at(-1) || item.root;
                if (seen.has(key)) {
                    duplicateCount++;
                    continue;
                }
                item.sourceFile = file.name;
                item.zip = result.zip;
                seen.set(key, item);
                all.push(item);
            }
        }

        entries = all;
        const install = await getInstallContext();
        for (const item of entries) {
            const key = extensionFolderKey(item);
            item.existing = install.installedThirdParty.has(key);
        }

        renderList(entries);
        const thirdParty = entries.filter(x => x.type === 'third-party').length;
        const builtin = entries.filter(isBuiltin).length;
        const importable = entries.filter(isImportable).length;
        $('#stei_count').text(`共 ${entries.length} 个 · 第三方 ${thirdParty} · 内置 ${builtin}${duplicateCount ? ` · 重复 ${duplicateCount}` : ''}`);
        $('#stei_summary').show();
        $('#stei_rescan').show();
        setStatus(`扫描完成：${list.length} 个 ZIP，共 ${importable} 个可导入扩展。${duplicateCount ? ` 已去重 ${duplicateCount} 个重复扩展。` : ''}`, true);
    } catch (error) {
        selectedZips = [];
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
    if (!selectedZips.length && !selected.some(item => item.sourceFolder)) return setStatus('请先选择 ST 文件夹或 ZIP。');

    try {
        const dataRoot = await getInstallBaseDir();
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
                if (item.sourceFolder) await importFolderItem(item, dataRoot, overwrite);
                else await importItem(item, item.zip, dataRoot, overwrite);
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

    $('#stei_header_toggle').on('click', function () {
        const panel = document.querySelector('.stei-panel');
        if (!panel) return;
        const collapsed = panel.classList.toggle('stei-collapsed');
        $(this).attr('aria-expanded', String(!collapsed));
    });

    $('#stei_pick_local').on('click', handlePickExtensionFiles);
    $('#stei_pick').on('click', () => {
        const input = document.getElementById('stei_file_input');
        if (!input) {
            setStatus('文件选择器初始化失败：找不到 ZIP 输入控件。');
            return;
        }
        input.click();
    });
    $('#stei_rescan').on('click', () => selectedFolderPath ? handlePickFolderPath(selectedFolderPath) : (selectedFiles.length && handlePick(selectedFiles)));
    $('#stei_select_all').on('click', () => selectAll(true));
    $('#stei_select_none').on('click', () => selectAll(false));
    $('#stei_import').on('click', importSelected);
    $('#stei_file_input').on('change', function () {
        const files = [...(this.files || [])];
        this.value = '';
        handlePick(files);
    });
}

jQuery(async () => {
    try { await init(); }
    catch (error) { console.error('[ST Extension Importer] init failed', error); }
});
