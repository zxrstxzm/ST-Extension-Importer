import { renderExtensionTemplateAsync } from '../../../extensions.js';

const EXTENSION_NAME = 'third-party/ST-Extension-Importer';
const VERSION = '0.8.5';
const MAX_ARCHIVE_BYTES = 16 * 1024 * 1024 * 1024;
const MAX_TOTAL_ARCHIVE_BYTES = 16 * 1024 * 1024 * 1024;
const MAX_TOTAL_UNCOMPRESSED = 64 * 1024 * 1024 * 1024;
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
    if (bytes.byteLength > MAX_ARCHIVE_BYTES) throw new Error('ZIP 超过 16 GB 限制；最终导入由 TauriTavern 原生归档系统负责。');
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
            if (total > MAX_TOTAL_UNCOMPRESSED) throw new Error('ZIP 解压总大小超过 64 GB');
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


function crc32(bytes) {
    // Small, self-contained CRC-32 implementation for rebuilding a normalized
    // archive in the WebView. We intentionally use ZIP "store" entries so the
    // generated archive does not depend on CompressionStream/Deflate support.
    if (!crc32.table) {
        const table = new Uint32Array(256);
        for (let n = 0; n < 256; n++) {
            let c = n;
            for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
            table[n] = c >>> 0;
        }
        crc32.table = table;
    }
    let c = 0xFFFFFFFF;
    for (const byte of bytes) c = crc32.table[(c ^ byte) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
}

function writeU16(out, offset, value) {
    out.setUint16(offset, value & 0xFFFF, true);
}

function writeU32(out, offset, value) {
    out.setUint32(offset, value >>> 0, true);
}

function encodeZipName(name) {
    return new TextEncoder().encode(String(name).replace(/\\/g, '/'));
}

function makeStoredZip(entries) {
    // ZIP32 is sufficient for extension packages in this importer. Keep the
    // archive small by storing already-decoded extension files without a
    // second compression pass; TauriTavern's native importer will read it.
    const prepared = entries.filter(entry => entry?.name && entry?.bytes instanceof Uint8Array);
    let localSize = 0;
    let centralSize = 0;
    const records = [];

    for (const entry of prepared) {
        const nameBytes = encodeZipName(entry.name);
        if (nameBytes.length > 0xFFFF) throw new Error(`ZIP 文件名过长：${entry.name}`);
        if (entry.bytes.byteLength > 0xFFFFFFFF) throw new Error(`扩展文件超过 ZIP32 单文件限制：${entry.name}`);
        const crc = crc32(entry.bytes);
        const localOffset = localSize;
        const localLength = 30 + nameBytes.length + entry.bytes.byteLength;
        const centralLength = 46 + nameBytes.length;
        if (localOffset > 0xFFFFFFFF || localLength > 0xFFFFFFFF) {
            throw new Error('生成的归档超过 ZIP32 限制。');
        }
        records.push({ ...entry, nameBytes, crc, localOffset });
        localSize += localLength;
        centralSize += centralLength;
    }

    const totalSize = localSize + centralSize + 22;
    if (totalSize > 0xFFFFFFFF) throw new Error('生成的归档超过 ZIP32 4 GB 限制，请拆分插件后再导入。');

    const out = new Uint8Array(totalSize);
    const view = new DataView(out.buffer);
    let offset = 0;

    for (const entry of records) {
        writeU32(view, offset, 0x04034B50);
        writeU16(view, offset + 4, 20);       // version needed
        writeU16(view, offset + 6, 0x0800);   // UTF-8 names
        writeU16(view, offset + 8, 0);        // stored
        writeU16(view, offset + 10, 0);
        writeU16(view, offset + 12, 0);
        writeU32(view, offset + 14, entry.crc);
        writeU32(view, offset + 18, entry.bytes.byteLength);
        writeU32(view, offset + 22, entry.bytes.byteLength);
        writeU16(view, offset + 26, entry.nameBytes.length);
        writeU16(view, offset + 28, 0);
        out.set(entry.nameBytes, offset + 30);
        out.set(entry.bytes, offset + 30 + entry.nameBytes.length);
        offset += 30 + entry.nameBytes.length + entry.bytes.byteLength;
    }

    const centralOffset = offset;
    for (const entry of records) {
        writeU32(view, offset, 0x02014B50);
        writeU16(view, offset + 4, 20);       // made by
        writeU16(view, offset + 6, 20);       // version needed
        writeU16(view, offset + 8, 0x0800);   // UTF-8 names
        writeU16(view, offset + 10, 0);       // stored
        writeU16(view, offset + 12, 0);
        writeU16(view, offset + 14, 0);
        writeU32(view, offset + 16, entry.crc);
        writeU32(view, offset + 20, entry.bytes.byteLength);
        writeU32(view, offset + 24, entry.bytes.byteLength);
        writeU16(view, offset + 28, entry.nameBytes.length);
        writeU16(view, offset + 30, 0);
        writeU16(view, offset + 32, 0);
        writeU16(view, offset + 34, 0);
        writeU16(view, offset + 36, 0);
        writeU32(view, offset + 38, 0);
        writeU32(view, offset + 42, entry.localOffset);
        out.set(entry.nameBytes, offset + 46);
        offset += 46 + entry.nameBytes.length;
    }

    writeU32(view, offset, 0x06054B50);
    writeU16(view, offset + 4, 0);
    writeU16(view, offset + 6, 0);
    writeU16(view, offset + 8, records.length);
    writeU16(view, offset + 10, records.length);
    writeU32(view, offset + 12, centralSize);
    writeU32(view, offset + 16, centralOffset);
    writeU16(view, offset + 20, 0);

    return new Blob([out], { type: 'application/zip' });
}

function cloneManifestValue(value) {
    if (Array.isArray(value)) return value.map(cloneManifestValue);
    if (value && typeof value === 'object') {
        const out = {};
        for (const [key, child] of Object.entries(value)) out[key] = cloneManifestValue(child);
        return out;
    }
    return value;
}

function normalizeResourcePathForMatch(value) {
    return String(value || '')
        .replace(/\\/g, '/')
        .replace(/^\.\//, '')
        .replace(/^\/+/, '')
        .split(/[?#]/, 1)[0]
        .replace(/\/+/g, '/')
        .trim();
}

function findBestArchivePath(item, requestedPath) {
    const wanted = normalizeResourcePathForMatch(requestedPath);
    if (!wanted) return null;
    const files = (item.fileList || []).filter(e => !e.directory && e.name);
    const exact = files.find(e => normalizeResourcePathForMatch(e.name) === wanted);
    if (exact) return exact.name;

    const lowerWanted = wanted.toLowerCase();
    const caseInsensitive = files.filter(e => normalizeResourcePathForMatch(e.name).toLowerCase() === lowerWanted);
    if (caseInsensitive.length === 1) return caseInsensitive[0].name;

    // GitHub repositories often put the real frontend assets under src/ or public/,
    // while the manifest still uses paths relative to the built extension root.
    // If the requested path exists as a unique suffix, retarget the manifest to it.
    const suffix = `/${lowerWanted}`;
    const suffixMatches = files.filter(e => {
        const path = normalizeResourcePathForMatch(e.name).toLowerCase();
        return path.endsWith(suffix);
    });
    if (suffixMatches.length === 1) return suffixMatches[0].name;

    // Last-resort compatibility for packages that moved an asset but kept its
    // basename. Only accept a unique basename to avoid silently choosing the
    // wrong stylesheet/script.
    const basename = lowerWanted.split('/').filter(Boolean).at(-1);
    if (basename) {
        const basenameMatches = files.filter(e => normalizeResourcePathForMatch(e.name).toLowerCase().split('/').at(-1) === basename);
        if (basenameMatches.length === 1) return basenameMatches[0].name;
    }
    return null;
}

function rewriteManifestResourceValue(value, item, missing) {
    if (typeof value === 'string') {
        const requested = normalizeResourcePathForMatch(value);
        if (!requested || /^https?:\/\//i.test(requested) || requested.startsWith('//')) return value;
        const resolved = findBestArchivePath(item, requested);
        if (resolved) return resolved;
        missing.push(requested);
        return value;
    }
    if (Array.isArray(value)) return value.map(child => rewriteManifestResourceValue(child, item, missing));
    return value;
}

async function readExtensionEntryBytes(item, entry) {
    if (item?.zip?.readEntry) return item.zip.readEntry(entry);
    if (item?.sourceFolder && entry?.path) return readFsFile(entry.path);
    throw new Error(`无法读取扩展文件：${entry?.name || entry?.path || 'unknown'}`);
}

async function prepareManifestForTT(item, zip) {
    const manifestEntry = (item.fileList || []).find(e => !e.directory && String(e.name || '').toLowerCase() === 'manifest.json');
    if (!manifestEntry) {
        item.ttManifest = null;
        item.ttManifestMissing = [];
        return null;
    }

    let meta;
    try {
        meta = JSON.parse(new TextDecoder().decode(await readExtensionEntryBytes(item, manifestEntry)));
    } catch {
        item.ttManifest = null;
        item.ttManifestMissing = [];
        return null;
    }

    const patched = cloneManifestValue(meta);
    const missing = [];
    for (const key of ['js', 'css']) {
        if (Object.prototype.hasOwnProperty.call(patched, key)) {
            patched[key] = rewriteManifestResourceValue(patched[key], item, missing);
        }
    }
    if (patched.i18n && typeof patched.i18n === 'object' && !Array.isArray(patched.i18n)) {
        for (const [locale, resource] of Object.entries(patched.i18n)) {
            patched.i18n[locale] = rewriteManifestResourceValue(resource, item, missing);
        }
    }

    // TauriTavern currently exposes the SillyTavern 1.18.0 compatibility baseline.
    // Do not lie about extensions requiring newer ST APIs; report those separately
    // instead of silently lowering the requirement.
    const minClient = String(patched.minimum_client_version ?? '').trim();
    item.ttRequiresNewerST = Boolean(minClient && versionGreaterThan(minClient, '1.18.0'));
    item.ttManifestMissing = [...new Set(missing)];
    item.ttManifest = patched;
    return { manifestEntry, original: meta, patched };
}

function versionGreaterThan(a, b) {
    const clean = value => String(value || '').replace(/^SillyTavern:/i, '').split(':')[0].trim();
    const pa = clean(a).split('.').map(x => Number.parseInt(x, 10) || 0);
    const pb = clean(b).split('.').map(x => Number.parseInt(x, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
    }
    return false;
}

async function buildNativeExtensionArchive(items) {
    const archiveEntries = [];
    const seen = new Set();

    for (const item of items) {
        const root = targetRelativeRoot(item);
        const prepared = await prepareManifestForTT(item, item.zip || selectedZipForItem(item));
        if (item.ttManifestMissing?.length) {
            throw new Error(`扩展“${item.displayName}”的 manifest 仍引用不存在的文件：${item.ttManifestMissing.join('、')}。已停止导入，避免产生“已安装但加载失败”的假安装。`);
        }
        if (item.ttRequiresNewerST) {
            item.ttWarning = '该扩展声明需要高于 TauriTavern 当前 SillyTavern 1.18.0 兼容基线的版本；未强行降低版本要求。';
        }

        for (const entry of item.fileList || []) {
            if (entry.directory) continue;
            const rel = safeZipRelativePath(item, entry);
            if (!rel || !isRuntimeImportableRelativePath(rel)) continue;

            const name = `extensions/third-party/${root}/${rel}`;
            if (seen.has(name)) continue;
            seen.add(name);

            let bytes = await readExtensionEntryBytes(item, entry);
            if (prepared?.manifestEntry && entry === prepared.manifestEntry && item.ttManifest) {
                bytes = new TextEncoder().encode(`${JSON.stringify(item.ttManifest, null, 2)}\n`);
            }
            archiveEntries.push({ name, bytes });
        }
    }

    if (!archiveEntries.length) {
        throw new Error('选中的扩展没有可导入的运行时文件。');
    }

    return makeStoredZip(archiveEntries);
}

function selectedZipForItem(item) {
    return item?.zip || selectedZips?.[0]?.zip || null;
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
    return parts.includes('.git') || parts.includes('.github') || parts.includes('.gitignore') || parts.includes('.gitattributes') || parts.includes('.gitmodules') || parts.includes('.gitkeep') || parts.includes('node_modules');
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
                    zip,
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
        const rawFileList = mapped.filter(e => e.name === root || e.name.startsWith(`${root}/`));
        // Convert every entry to a path RELATIVE TO THIS EXTENSION now.
        // Import no longer needs to reconstruct the prefix later, which avoids
        // failures with Android/MT Manager ZIPs and explicit directory records.
        const fileList = rawFileList.map(e => {
            if (e.name === root) return { ...e, name: '' };
            return { ...e, name: e.name.slice(root.length + 1) };
        });
        const manifest = fileList.find(e => !e.directory && e.name.toLowerCase() === 'manifest.json');

        let meta = {};
        if (manifest) {
            meta = await readZipManifest(zip, rawFileList.find(e => e === manifest) || manifest) || {};
        }

        const hasUsefulFile = fileList.some(e =>
            !e.directory && /\.(?:js|mjs|cjs|html?|css|json|wasm)$/i.test(e.name)
        );
        if (!fileList.some(e => !e.directory) || !hasUsefulFile) continue;

        found.push({
            zip,
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
                zip,
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
    // Extension directory names are allowed to contain Unicode (for example
    // Chinese extension names). Only reject path separators, traversal, NUL
    // and control characters.
    if (!name || name === '.' || name === '..' || /[\\/\0\x00-\x1F\x7F]/u.test(name)) {
        throw new Error(`扩展目录名不安全: ${name}`);
    }
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
          ${builtin ? '<div class="stei-item-warning">TT 已有对应内置扩展，默认不导入。</div>' : ''}${item.sourceFolder && !item.hasManifest ? '<div class="stei-item-warning">未发现 manifest.json，但它位于 third-party 的直接子目录中，将按扩展目录迁移。</div>' : ''}${item.empty ? '<div class="stei-item-warning">目录为空，无法导入。</div>' : ''}${item.unreadable ? `<div class="stei-item-warning">无法读取：${escapeHtml(item.scanError || '未知错误')}</div>` : ''}${item.repoPackage && item.hasServerPlugin ? '<div class="stei-item-warning">此仓库同时包含 Server Plugin；当前仅迁移前端扩展文件，后端插件不会被放进 third-party 目录。</div>' : ''}${item.ttWarning ? `<div class="stei-item-warning">${escapeHtml(item.ttWarning)}</div>` : ''}
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

async function isInstalledExtensionDirectory(rootPath) {
    try {
        const raw = await readFsFile(`${rootPath}/manifest.json`);
        const meta = JSON.parse(new TextDecoder().decode(raw));
        if (!isValidExtensionManifest(meta)) return false;
        const resources = [];
        for (const key of ['js', 'css']) {
            const value = meta[key];
            const values = Array.isArray(value) ? value : [value];
            for (const rawPath of values) {
                if (typeof rawPath !== 'string') continue;
                const rel = normalizeManifestFilePath(rawPath);
                if (!rel || /^https?:\/\//i.test(rel) || rel.startsWith('//')) continue;
                resources.push(rel);
            }
        }
        if (!resources.length) return false;
        for (const rel of resources) {
            if (!(await fileExistsByReadDir(`${rootPath}/${rel}`))) return false;
        }
        return true;
    } catch {
        return false;
    }
}

async function collectInstalledExtensionNames(list, thirdPartyRoot) {
    const installed = new Set();
    try {
        const children = await readFsDir(thirdPartyRoot);
        for (const child of children) {
            const name = basenamePath(child?.name || child?.path || '').trim();
            const isDir = Boolean(child?.isDirectory ?? child?.is_dir ?? child?.is_directory ?? child?.directory ?? child?.children);
            if (!isDir || !name || name === '.' || name === '..' || name.startsWith('.')) continue;
            const root = `${thirdPartyRoot}/${name}`;
            if (await isInstalledExtensionDirectory(root)) {
                installed.add(name.toLowerCase());
            } else {
                // Clean only a clearly broken extension tree: keep ordinary
                // folders untouched, but remove a manifest-based package whose
                // required runtime files are missing. This repairs leftovers
                // from earlier failed imports instead of labeling them installed.
                try {
                    const raw = await readFsFile(`${root}/manifest.json`);
                    const meta = JSON.parse(new TextDecoder().decode(raw));
                    if (isValidExtensionManifest(meta)) await remove(root, { verify: true });
                } catch { /* not a recognizable broken extension package */ }
            }
        }
        return installed;
    } catch {
        // Fallback for TT builds where read_dir is temporarily unavailable.
    }
    for (const item of list) {
        for (const value of [item?.name, item?.path, item?.folder, item?.directory]) {
            const p = normalizeFsPath(value);
            if (!p) continue;
            const parts = p.split('/').filter(Boolean);
            const tp = parts.map(x => x.toLowerCase()).lastIndexOf('third-party');
            if (tp < 0 || !parts[tp + 1]) continue;
            const root = '/' + parts.slice(0, tp + 2).join('/');
            if (await isInstalledExtensionDirectory(root)) installed.add(parts[tp + 1].toLowerCase());
        }
    }
    return installed;
}

function getThirdPartyFolderFromExtensionName(name) {
    const normalized = String(name || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    const parts = normalized.split('/').filter(Boolean);
    const index = parts.map(x => x.toLowerCase()).lastIndexOf('third-party');
    return index >= 0 && parts[index + 1] ? parts[index + 1] : '';
}

function extensionResourceUrl(folder, relativePath) {
    const clean = normalizeManifestFilePath(relativePath);
    if (!clean || /^https?:\/\//i.test(clean) || clean.startsWith('//')) return '';
    const parts = clean.split('/').filter(Boolean).map(part => encodeURIComponent(part));
    return `/scripts/extensions/third-party/${encodeURIComponent(folder)}/${parts.join('/')}`;
}

async function fetchExtensionManifest(folder) {
    const url = extensionResourceUrl(folder, 'manifest.json');
    if (!url) return null;
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) return null;
    try {
        const meta = await response.json();
        return isValidExtensionManifest(meta) ? meta : null;
    } catch {
        return null;
    }
}

async function isInstalledExtensionViaHost(folder) {
    const meta = await fetchExtensionManifest(folder);
    if (!meta) return false;

    const resources = [];
    for (const key of ['js', 'css']) {
        const value = meta[key];
        const values = Array.isArray(value) ? value : [value];
        for (const rawPath of values) {
            if (typeof rawPath !== 'string') continue;
            const rel = normalizeManifestFilePath(rawPath);
            if (!rel || /^https?:\/\//i.test(rel) || rel.startsWith('//')) continue;
            resources.push({ type: key, path: rel });
        }
    }
    if (!resources.some(resource => resource.type === 'js')) return false;

    for (const resource of resources) {
        const url = extensionResourceUrl(folder, resource.path);
        if (!url) return false;
        try {
            const response = await fetch(url, { cache: 'no-store' });
            if (!response.ok) return false;
        } catch {
            return false;
        }
    }
    return true;
}

async function deleteExtensionViaHost(extensionName, global = false) {
    const response = await fetch('/api/extensions/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ extensionName, global: Boolean(global) }),
    });
    if (!response.ok) {
        const text = await response.text();
        throw new Error(String(text || response.statusText || '删除残留扩展失败'));
    }
}

async function getInstallContext() {
    const invoke = getSafeInvoke();
    const list = await invoke('get_extensions');
    if (!Array.isArray(list)) throw new Error('无法取得 TauriTavern 扩展列表');

    const self = list.find(item => {
        const values = [item?.name, item?.path, item?.folder].map(x => normalizeFsPath(x).toLowerCase());
        return values.some(x => x === 'st-extension-importer' || x.endsWith('/st-extension-importer') || x.endsWith('/st-extension-importer/index.js'));
    });

    const installedThirdParty = new Set();
    const invalidThirdParty = [];
    for (const extension of list) {
        const name = String(extension?.name || '').trim();
        if (!/^third-party\//i.test(name)) continue;
        const folder = getThirdPartyFolderFromExtensionName(name);
        if (!folder || folder.toLowerCase() === 'st-extension-importer') continue;

        const valid = await isInstalledExtensionViaHost(folder);
        const key = folder.toLowerCase();
        if (valid) {
            installedThirdParty.add(key);
        } else {
            invalidThirdParty.push({
                extensionName: name,
                folder,
                global: String(extension?.extension_type || '').toLowerCase() === 'global',
            });
        }
    }

    // TT's discovery list is directory-based, so a broken leftover directory can
    // appear as "installed" even when manifest.js/css cannot actually load.
    // Remove only entries that fail the same resource checks the WebView uses.
    for (const broken of invalidThirdParty) {
        try {
            await deleteExtensionViaHost(broken.extensionName, broken.global);
        } catch (error) {
            console.warn('Failed to clean broken extension:', broken.extensionName, error);
        }
    }

    return {
        installedThirdParty,
        extensions: list,
        self,
        // No physical filesystem path is exposed here. Android extension
        // installation is performed through TT's archive service below.
        baseDir: '',
    };
}

async function getInstallBaseDir() {
    return (await getInstallContext()).baseDir;
}

async function mkdir(path) {
    try {
        await fsInvoke('plugin:fs|mkdir', { path, options: { recursive: true } });
    } catch (error) {
        // Android's fs plugin may return EEXIST even for a perfectly valid
        // directory. This is especially common when several files share the
        // same parent (for example dist/). Treat ONLY EEXIST as success; other
        // errors still abort the import.
        const message = String(error?.message || error || '');
        if (/EEXIST|os error 17|File exists/i.test(message)) return;
        if (await existsDir(path)) return;
        throw error;
    }
}

async function mkdirOnce(path, createdDirs) {
    const normalized = normalizeFsPath(path);
    if (!normalized || createdDirs.has(normalized)) return;
    await mkdir(normalized);
    createdDirs.add(normalized);
}

// Android/Tauri can contain a stale FILE where the new extension expects a
// DIRECTORY (for example: tokimemo/dist is a file, while the new package
// needs tokimemo/dist/heartbeatMemories.bundle.js). `mkdir(..., recursive)`
// cannot repair that shape mismatch and returns ENOTDIR. Before creating every
// parent directory, walk its components and replace any file occupying a
// required directory slot. This makes imports genuinely overwrite-safe, even
// when a previous broken import left a malformed tree behind.
async function ensureDirectoryPath(path, createdDirs) {
    const normalized = normalizeFsPath(path);
    if (!normalized || createdDirs.has(normalized)) return;

    const absolute = normalized.startsWith('/');
    const parts = normalized.split('/').filter(Boolean);
    let current = absolute ? '' : '';

    for (const part of parts) {
        current = current ? `${current}/${part}` : (absolute ? `/${part}` : part);
        if (createdDirs.has(current)) continue;

        const parent = dirnamePath(current);
        const name = basenamePath(current);
        let found = null;
        try {
            const children = await readFsDir(parent);
            found = children.find(child => basenamePath(child?.name || child?.path || '') === name) || null;
        } catch {
            // If the parent cannot be enumerated, fall back to mkdir below.
        }

        if (found) {
            const isDir = Boolean(
                found?.isDirectory ?? found?.is_dir ?? found?.is_directory ??
                found?.directory ?? found?.children
            );
            if (!isDir) {
                const stalePath = String(found?.path || current);
                await remove(stalePath, { verify: true });
            }
        }

        await mkdir(current);
        createdDirs.add(current);
    }
}

async function ensureFileTargetAvailable(path) {
    const normalized = normalizeFsPath(path);
    if (!normalized) return;
    const parent = dirnamePath(normalized);
    const name = basenamePath(normalized);
    try {
        const children = await readFsDir(parent);
        const found = children.find(child => basenamePath(child?.name || child?.path || '') === name);
        if (found) {
            await remove(String(found?.path || normalized), { verify: true });
        }
    } catch {
        // The target is absent or the parent is not enumerable; write_file will
        // report a real error if it cannot create/replace it.
    }
}

async function remove(path, { verify = false } = {}) {
    try {
        await fsInvoke('plugin:fs|remove', { path, options: { recursive: true } });
    } catch (error) {
        // If it is already absent, that is fine. IMPORTANT: existsDir() only
        // detects directories. A stale FILE at the same path would otherwise
        // be mistaken for "absent", and the next mkdir/write would fail with
        // Android's "Not a directory (os error 20)". Check for either a file
        // or a directory before deciding the path is really gone.
        if (await pathExistsAny(path)) throw error;
        return;
    }
    if (verify) {
        // Android can report a successful remove while the old entry is still
        // visible for a short time. Do not start copying into a stale tree.
        for (let i = 0; i < 8; i++) {
            if (!(await pathExistsAny(path))) return;
            await new Promise(resolve => setTimeout(resolve, 60));
        }
        if (await pathExistsAny(path)) {
            throw new Error(`无法覆盖旧扩展目录，删除后仍存在：${path}`);
        }
    }
}

async function pathExistsAny(path) {
    const normalized = normalizeFsPath(path);
    if (!normalized) return false;
    try {
        const parent = dirnamePath(normalized);
        const name = basenamePath(normalized);
        const children = await readFsDir(parent);
        return children.some(child => basenamePath(child?.name || child?.path || '') === name);
    } catch {
        return false;
    }
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

function isRuntimeImportableRelativePath(path) {
    const rel = String(path || '').replace(/\\/g, '/').replace(/^\/+/, '');
    const parts = rel.split('/').filter(Boolean);
    if (!parts.length) return false;
    // TauriTavern's mobile fs backend rejects hidden/dev-control files such as
    // .eslintrc.json. They are not runtime assets of a SillyTavern frontend
    // extension, so skip them instead of failing the whole extension.
    const ignoredNames = new Set([
        '.gitignore', '.gitattributes', '.editorconfig', '.npmrc', '.yarnrc',
        '.prettierrc', '.prettierrc.json', '.prettierrc.js', '.prettierignore',
        '.eslintignore', '.eslintrc', '.eslintrc.json', '.eslintrc.js', '.eslintrc.cjs',
        '.stylelintrc', '.stylelintrc.json', '.stylelintrc.js', '.stylelintignore',
        '.DS_Store', 'thumbs.db'
    ]);
    return !parts.some(part => part.startsWith('.') || ignoredNames.has(part.toLowerCase()));
}

function safeZipRelativePath(item, entry) {
    const rel = String(entry?.name || '').replace(/\\/g, '/').replace(/^\/+/, '');
    if (!rel) return null; // explicit directory entry
    const parts = rel.split('/');
    if (
        parts.some(part => !part || part === '.' || part === '..') ||
        /^[A-Za-z]:[\\/]/.test(rel) ||
        rel.startsWith('/')
    ) {
        throw new Error(`不安全的扩展文件路径: ${entry?.name || ''}`);
    }
    return rel;
}

function manifestResourceList(item) {
    const meta = item?.meta || {};
    const out = [];
    for (const key of ['css', 'js']) {
        const value = meta[key];
        const values = Array.isArray(value) ? value : [value];
        for (const raw of values) {
            if (typeof raw !== 'string') continue;
            let rel = raw.trim().replace(/\\/g, '/').replace(/^\.\//, '');
            if (!rel || /^https?:\/\//i.test(rel) || rel.startsWith('//')) continue;
            // SillyTavern manifests sometimes append cache-busting query strings,
            // e.g. index.js?heartbeat=0.99... . The query is not part of the
            // filesystem filename and must not make a valid file look missing.
            rel = rel.split(/[?#]/, 1)[0].trim();
            if (!rel) continue;
            out.push({ type: key, path: rel });
        }
    }
    return out;
}

function normalizeManifestFilePath(value) {
    return String(value || '')
        .replace(/\\/g, '/')
        .replace(/^\.\//, '')
        .replace(/^\/+/, '')
        .split(/[?#]/, 1)[0];
}

function hasItemFile(item, relativePath) {
    const wanted = normalizeManifestFilePath(relativePath);
    return item.fileList.some(entry => normalizeManifestFilePath(entry?.name || '') === wanted);
}

async function validateManifestResources(item) {
    const missing = manifestResourceList(item).filter(resource => !hasItemFile(item, resource.path));
    if (missing.length) {
        throw new Error(`扩展 ${item.displayName} 的 manifest 引用了不存在的文件：${missing.map(x => `${x.type}: ${x.path}`).join(', ')}`);
    }
}

async function fileExistsByReadDir(path) {
    const normalized = normalizeFsPath(path);
    const parent = dirnamePath(normalized);
    const name = basenamePath(normalized);
    try {
        const children = await readFsDir(parent);
        return children.some(child => basenamePath(child?.name || child?.path || '') === name);
    } catch {
        return false;
    }
}

async function verifyManifestResourcesInstalled(item, targetRoot) {
    const missing = [];
    for (const resource of manifestResourceList(item)) {
        const target = `${targetRoot}/${resource.path}`;
        if (!(await fileExistsByReadDir(target))) missing.push(`${resource.type}: ${resource.path}`);
    }
    if (missing.length) {
        throw new Error(`导入后检测到扩展资源缺失：${missing.join(', ')}`);
    }
}

async function importItem(item, zip, dataRoot, overwrite) {
    const targetRoot = `${dataRoot.replace(/[\/]$/, '')}/${targetRelativeRoot(item)}`;
    const installedBefore = Boolean(item.existing);
    const existedBefore = await existsDir(targetRoot);
    if (overwrite) await remove(targetRoot, { verify: true });
    const createdDirs = new Set();
    const previousMeta = item.meta;
    try {
        const prepared = await prepareManifestForTT(item, zip);
        if (item.ttManifestMissing?.length) throw new Error(`manifest 引用了不存在的文件：${item.ttManifestMissing.join('、')}`);
        if (item.ttRequiresNewerST) item.ttWarning = '该扩展声明需要高于 TauriTavern 当前 SillyTavern 1.18.0 兼容基线的版本；未强行降低版本要求。';
        if (item.ttManifest) item.meta = item.ttManifest;
        await validateManifestResources(item);
        await mkdirOnce(targetRoot, createdDirs);
        for (const entry of item.fileList) {
            if (entry.directory) continue;
            const rel = safeZipRelativePath(item, entry);
            if (!rel || !isRuntimeImportableRelativePath(rel)) continue;
            const target = `${targetRoot}/${rel}`;
            const parentParts = target.split('/'); parentParts.pop();
            await ensureDirectoryPath(parentParts.join('/'), createdDirs);
            await ensureFileTargetAvailable(target);
            let bytes = await zip.readEntry(entry);
            if (prepared?.manifestEntry && entry === prepared.manifestEntry && item.ttManifest) {
                bytes = new TextEncoder().encode(`${JSON.stringify(item.ttManifest, null, 2)}
`);
            }
            await writeFile(target, bytes);
        }
        await verifyManifestResourcesInstalled(item, targetRoot);
    } catch (error) {
        if (!installedBefore || overwrite) {
            try { await remove(targetRoot, { verify: true }); } catch {}
        }
        throw error;
    } finally {
        item.meta = previousMeta;
    }
}

async function importFolderItem(item, dataRoot, overwrite) {
    const targetRoot = `${dataRoot.replace(/[\\/]$/, '')}/${targetRelativeRoot(item)}`;
    const existedBefore = await existsDir(targetRoot);
    if (overwrite) await remove(targetRoot, { verify: true });
    const createdDirs = new Set();
    const previousMeta = item.meta;

    try {
        // Folder imports get the same TT manifest normalization as ZIP imports.
        if (item.meta && item.hasManifest) {
            const manifestEntry = item.fileList.find(e => !e.directory && String(e.name || '').toLowerCase() === 'manifest.json');
            if (manifestEntry) {
                const raw = await readFsFile(manifestEntry.path);
                const meta = JSON.parse(new TextDecoder().decode(raw));
                const patched = cloneManifestValue(meta);
                const missing = [];
                for (const key of ['js', 'css']) {
                    if (Object.prototype.hasOwnProperty.call(patched, key)) patched[key] = rewriteManifestResourceValue(patched[key], item, missing);
                }
                if (patched.i18n && typeof patched.i18n === 'object' && !Array.isArray(patched.i18n)) {
                    for (const [locale, resource] of Object.entries(patched.i18n)) patched.i18n[locale] = rewriteManifestResourceValue(resource, item, missing);
                }
                item.ttManifestMissing = [...new Set(missing)];
                if (item.ttManifestMissing.length) throw new Error(`manifest 引用了不存在的文件：${item.ttManifestMissing.join('、')}`);
                item.ttManifest = patched;
                item.meta = patched;
            }
        }
        await validateManifestResources(item);
        await mkdirOnce(targetRoot, createdDirs);

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
        if (!isRuntimeImportableRelativePath(rel)) continue;
        const parts = rel.split('/');
        if (!rel || rel.startsWith('/') || parts.some(part => !part || part === '.' || part === '..') || /^[A-Za-z]:[\\/]/.test(rel)) {
            throw new Error(`不安全的扩展文件路径: ${entry.name || entry.path || item.root}`);
        }

        const target = `${targetRoot}/${rel}`;
        const parentParts = target.split('/');
        parentParts.pop();
        await ensureDirectoryPath(parentParts.join('/'), createdDirs);
        await ensureFileTargetAvailable(target);

        let bytes = await readFsFile(entry.path);
        if (String(entry.name || '').toLowerCase() === 'manifest.json' && item.ttManifest) {
            bytes = new TextEncoder().encode(`${JSON.stringify(item.ttManifest, null, 2)}\n`);
        }
        await writeFile(target, bytes);
        }
        await verifyManifestResourcesInstalled(item, targetRoot);
    } catch (error) {
        if (overwrite || !existedBefore) {
            try { await remove(targetRoot, { verify: true }); } catch {}
        }
        throw error;
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

function normalizePickerPath(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    if (/^file:\/\//i.test(raw)) {
        try {
            const url = new URL(raw);
            return decodeURIComponent(url.pathname);
        } catch {
            return raw.replace(/^file:\/\//i, '');
        }
    }
    if (/^content:\/\//i.test(raw) || /^ms-appx:\/\//i.test(raw)) {
        return '';
    }
    return raw;
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

        const rawPaths = (Array.isArray(picked) ? picked : [picked])
            .filter(Boolean)
            .map(String);
        const paths = rawPaths.map(normalizePickerPath).filter(Boolean);

        if (!paths.length) {
            const sample = rawPaths[0] || '';
            if (/^content:\/\//i.test(sample)) {
                throw new Error('Android 文件选择器返回的是 content:// URI，不是可供 plugin:fs 使用的本地路径。请改用 ZIP 导入，或在下方手动输入 SillyTavern/third-party 的真实路径。');
            }
            throw new Error('文件选择器没有返回可用的本地路径。请改用 ZIP 导入，或手动输入 third-party 路径。');
        }

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

async function handleScanManualPath() {
    try {
        const input = document.getElementById('stei_manual_path');
        const path = String(input?.value || '').trim();
        if (!path) throw new Error('请先输入 third-party 路径。');
        if (/^content:\/\//i.test(path) || /^https?:\/\//i.test(path)) {
            throw new Error('这里需要真实本地路径，例如 /storage/XXXX/public/scripts/extensions/third-party，而不是 content:// 或 http(s) URL。');
        }
        await handlePickFolderPath(path);
    } catch (error) {
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

function rawTauriInvoke() {
    const invoke = window.__TAURI__?.core?.invoke;
    if (typeof invoke !== 'function') throw new Error('Tauri invoke API 不可用');
    return invoke;
}

function bytesToBase64(bytes) {
    let binary = '';
    const stride = 0x8000;
    for (let offset = 0; offset < bytes.byteLength; offset += stride) {
        binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + stride, bytes.byteLength)));
    }
    return btoa(binary);
}

async function stageArchiveBlobForTT(blob) {
    const invoke = rawTauriInvoke();
    let filePath = '';
    try {
        const begin = await invoke('stage_upload_begin', {
            dto: { kind: 'generic', preferred_extension: 'zip', size: blob.size },
        });
        filePath = String(begin?.file_path || '').trim();
        const chunkSize = Math.max(1, Number(begin?.chunk_size || 0));
        if (!filePath || !Number.isFinite(chunkSize)) throw new Error('TT 没有返回有效的归档暂存路径');

        let offset = 0;
        while (offset < blob.size) {
            const end = Math.min(offset + chunkSize, blob.size);
            const chunk = new Uint8Array(await blob.slice(offset, end).arrayBuffer());
            let nextOffset;
            if (/android/i.test(navigator.userAgent || '')) {
                nextOffset = await invoke('stage_upload_chunk', { data: bytesToBase64(chunk) }, {
                    headers: {
                        'chunk-encoding': 'base64',
                        'file-path': encodeURIComponent(filePath),
                        offset: String(offset),
                    },
                });
            } else {
                nextOffset = await invoke('stage_upload_chunk', chunk, {
                    headers: {
                        'file-path': encodeURIComponent(filePath),
                        offset: String(offset),
                    },
                });
            }
            offset = Number(nextOffset);
            if (offset !== end) throw new Error(`TT 归档暂存偏移异常：${offset} / ${end}`);
        }

        const finished = await invoke('stage_upload_finish', {
            // Raw Tauri IPC uses the command's camelCase argument names.
            filePath,
            expectedSize: blob.size,
        });
        const finishedPath = String(finished?.file_path || filePath).trim();
        if (!finishedPath) throw new Error('TT 没有返回完成后的归档路径');
        filePath = finishedPath;
        return {
            filePath,
            cleanup: async () => {
                try { await invoke('stage_upload_discard', { filePath }); } catch {}
            },
        };
    } catch (error) {
        if (filePath) {
            try { await invoke('stage_upload_discard', { filePath }); } catch {}
        }
        throw error;
    }
}

async function requestTTArchiveImportFromBlob(blob) {
    const staged = await stageArchiveBlobForTT(blob);
    try {
        const jobId = String(await rawTauriInvoke()('start_import_data_archive', {
            archivePath: staged.filePath,
            archiveIsTemporary: true,
        }) || '').trim();
        if (!jobId) throw new Error('TauriTavern 未返回归档导入任务 ID');
        return await waitNativeArchiveImport(jobId);
    } finally {
        // start_import_data_archive prepares/copies the archive synchronously
        // before returning the job id, so the staging file can be discarded now.
        await staged.cleanup();
    }
}

async function requestNativeArchiveImport(file) {
    const form = new FormData();
    form.append('archive', file, file.name || 'st-extension-import.zip');
    const response = await fetch('/api/extensions/data-migration/import', {
        method: 'POST',
        body: form,
    });
    if (!response.ok) {
        const text = await response.text();
        let message = text;
        try {
            const json = JSON.parse(text);
            message = json?.error || json?.message || text;
        } catch { /* plain text */ }
        throw new Error(String(message || '无法启动 TauriTavern 原生归档导入'));
    }
    const payload = await response.json();
    const jobId = String(payload?.job_id || '').trim();
    if (!jobId) throw new Error('TauriTavern 未返回导入任务 ID');
    return jobId;
}

async function getNativeArchiveJobStatus(jobId) {
    const response = await fetch(`/api/extensions/data-migration/job?id=${encodeURIComponent(jobId)}`, {
        method: 'GET',
        cache: 'no-store',
    });
    if (!response.ok) {
        const text = await response.text();
        let message = text;
        try {
            const json = JSON.parse(text);
            message = json?.error || json?.message || text;
        } catch { /* plain text */ }
        throw new Error(String(message || '无法读取导入任务状态'));
    }
    return response.json();
}

async function waitNativeArchiveImport(jobId, onStatus) {
    const terminal = new Set(['completed', 'failed', 'cancelled']);
    while (true) {
        const status = await getNativeArchiveJobStatus(jobId);
        onStatus?.(status);
        if (terminal.has(String(status?.state || '').toLowerCase())) return status;
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
}

async function cleanupFailedNewExtensionDirs(items, dataRoot) {
    const removed = [];
    const errors = [];
    for (const item of items) {
        const key = extensionFolderKey(item);
        // NEVER delete an extension that existed before this import attempt.
        if (item.existing) continue;
        const targetRoot = `${dataRoot.replace(/[\\/]$/, '')}/${targetRelativeRoot(item)}`;
        try {
            if (await pathExistsAny(targetRoot)) {
                await remove(targetRoot, { verify: true });
                removed.push(item.displayName);
            }
        } catch (error) {
            errors.push(`${item.displayName}: ${error?.message || String(error)}`);
        }
    }
    return { removed, errors };
}


async function importSelected() {
    const selected = selectedEntries();
    if (!selected.length) return setStatus('没有选择要导入的扩展。');
    try {
        await getInstallContext();
        const results = [];
        $('#stei_import').prop('disabled', true);
        setStatus(`开始通过 TT 原生归档引擎逐个导入 ${selected.length} 个扩展…`);

        for (let i = 0; i < selected.length; i++) {
            const item = selected[i];
            const folder = extensionFolderKey(item);
            const existedBefore = Boolean(item.existing);
            setStatus(`正在导入 ${i + 1}/${selected.length}：${item.displayName}…`);
            try {
                // Build a one-extension DataRoot archive. This is deliberately
                // installed by TT's backend archive service rather than the
                // WebView fs plugin, which is forbidden from touching Android's
                // /storage path.
                const archive = await buildNativeExtensionArchive([item]);
                const status = await requestTTArchiveImportFromBlob(archive);
                if (String(status?.state || '').toLowerCase() !== 'completed') {
                    throw new Error(String(status?.error || status?.message || 'TT 原生归档导入失败'));
                }

                const validAfter = await isInstalledExtensionViaHost(folder);
                if (!validAfter) {
                    // A completed archive job without a loadable manifest is not
                    // considered an installation. Clean it through TT's backend
                    // instead of touching the protected filesystem from Android.
                    const list = await getSafeInvoke()('get_extensions');
                    const installed = Array.isArray(list)
                        ? list.find(x => String(x?.name || '').toLowerCase() === `third-party/${folder}`.toLowerCase())
                        : null;
                    if (installed) {
                        try {
                            await deleteExtensionViaHost(`third-party/${folder}`, String(installed?.extension_type || '').toLowerCase() === 'global');
                        } catch {}
                    }
                    throw new Error('TT 归档导入完成，但扩展 manifest / JS / CSS 仍无法加载');
                }

                item.existing = true;
                results.push({ item, ok: true, existedBefore, error: '' });
            } catch (error) {
                const message = error?.message || String(error);
                const validAfter = await isInstalledExtensionViaHost(folder);
                if (!validAfter) {
                    item.existing = false;
                    // Remove a newly-created broken/partial directory through TT's
                    // extension management API. Never use /storage paths here.
                    const list = await getSafeInvoke()('get_extensions');
                    const installed = Array.isArray(list)
                        ? list.find(x => String(x?.name || '').toLowerCase() === `third-party/${folder}`.toLowerCase())
                        : null;
                    if (installed) {
                        try {
                            await deleteExtensionViaHost(`third-party/${folder}`, String(installed?.extension_type || '').toLowerCase() === 'global');
                        } catch {}
                    }
                } else {
                    item.existing = true;
                }
                results.push({ item, ok: false, existedBefore, error: message });
            }
        }

        const okCount = results.filter(x => x.ok).length;
        const failCount = results.length - okCount;
        const lines = results.map(x => {
            if (x.ok) return `✓ ${x.item.displayName}：已安装`;
            if (x.item.existing && x.existedBefore) return `⚠ ${x.item.displayName}：导入失败，保留原有安装（${x.error}）`;
            return `✕ ${x.item.displayName}：未安装（${x.error}）`;
        });
        $('#stei_result').html(`<div class="stei-result-title">导入结果</div><div class="stei-result-lines">${lines.map(escapeHtml).join('<br>')}</div>`).show();
        renderList(entries);
        if (failCount === 0) {
            setStatus(`导入完成：${okCount} 个扩展逐个通过 TT 原生加载验证。建议重新加载 TT。`);
            window.toastr?.success?.(`ST 扩展导入完成：${okCount} 个`, 'ST Extension Importer');
        } else {
            setStatus(`导入结束：${okCount} 个成功，${failCount} 个未安装/保留旧版本。`);
            window.toastr?.error?.(`有 ${failCount} 个扩展未通过安装验证，请查看下方逐项结果。`, 'ST Extension Importer');
        }
    } catch (error) {
        setStatus(`导入失败：${error?.message || error}`);
        window.toastr?.error?.(error?.message || String(error), 'ST Extension Importer');
    } finally {
        $('#stei_import').prop('disabled', false);
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

    $('#stei_pick').on('click', () => {
        const input = document.getElementById('stei_file_input');
        if (!input) {
            setStatus('文件选择器初始化失败：找不到 ZIP 输入控件。');
            return;
        }
        input.click();
    });
    $('#stei_rescan').on('click', () => selectedFiles.length && handlePick(selectedFiles));
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
