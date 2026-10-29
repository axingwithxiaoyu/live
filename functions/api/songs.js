// 歌曲接口（分块存储版）
// 背景：EdgeOne 函数请求体上限 1MB、读取大对象（>1MB）会 BLOB_GET_FAIL
// 方案：mp3 由浏览器切成 768KB 分块，逐块直传 Blob；播放时函数按 Range 读取所需分块拼接返回
// 键结构：song/<id>/000、song/<id>/001…（分块），song/<id>.lrc（歌词），meta/song/<id>（元数据）

const CHUNK = 786432; // 768KB，与前端保持一致

function json(data, status){
    return new Response(JSON.stringify(data), {
        status: status || 200,
        headers: {
            "content-type": "application/json; charset=utf-8",
            "access-control-allow-origin": "*",
            "access-control-allow-headers": "content-type",
            "access-control-allow-methods": "GET, POST, OPTIONS"
        }
    });
}

let _storePromise = null;
function loadStore(){
    if(!_storePromise){
        _storePromise = import("@edgeone/pages-blob").then(m => {
            const gs = m.getStore || (m.default && m.default.getStore);
            return gs ? gs("media") : null;
        }).catch(() => { _storePromise = null; return null; });
    }
    return _storePromise;
}

function pad3(i){ return String(i).padStart(3, "0"); }

async function metaList(store, prefix){
    const out = [];
    try{
        const res = await store.list({ prefix: prefix, consistency: "strong" });
        for(const b of (res.blobs || [])){
            try{
                const v = await store.get(b.key, { consistency: "strong" });
                if(v) out.push(JSON.parse(v));
            }catch(e){}
        }
    }catch(e){}
    out.sort((a, b) => (a.ts || 0) - (b.ts || 0));
    return out;
}

export async function onRequest({ request }){
    if(request.method === "OPTIONS") return json({ ok: true });

    const store = await loadStore();
    if(!store) return json({ ok: false, error: "BLOB_NOT_READY" }, 500);

    const url = new URL(request.url);
    const fileId = url.searchParams.get("file");
    const lrcId = url.searchParams.get("lrc");

    if(request.method === "GET"){
        if(fileId){
            // 读元数据，确定分块数与总大小
            let meta = null;
            try{
                const mv = await store.get("meta/song/" + fileId, { consistency: "strong" });
                meta = mv ? JSON.parse(mv) : null;
            }catch(e){}
            if(!meta || !meta.chunks){
                return json({ ok: false, error: "LEGACY_UNSUPPORTED", hint: "旧格式歌曲无法读取，请删除后重新上传" }, 500);
            }
            const total = meta.size || (meta.chunks * CHUNK);
            const baseHeaders = {
                "content-type": "audio/mpeg",
                "accept-ranges": "bytes",
                "cache-control": "public, max-age=86400",
                "access-control-allow-origin": "*"
            };
            // 解析 Range（浏览器音频总是分段拉流），单次响应最大 900KB（响应体同样受限）
            const range = request.headers.get("range");
            const m = range ? /bytes=(\d*)-(\d*)/.exec(range) : null;
            let start = 0, end = total - 1;
            if(m){
                start = m[1] ? parseInt(m[1], 10) : 0;
                end = m[2] ? parseInt(m[2], 10) : total - 1;
                if(!(start >= 0) || start >= total){
                    return new Response(null, { status: 416, headers: { "content-range": "bytes */" + total } });
                }
                if(!(end >= start) || end >= total) end = total - 1;
                const MAXRSP = 900 * 1024;
                if(end - start + 1 > MAXRSP) end = start + MAXRSP - 1;
            }
            // 读取覆盖 [start, end] 的全部分块并拼接
            const first = Math.floor(start / CHUNK);
            const last = Math.floor(end / CHUNK);
            const parts = [];
            for(let i = first; i <= last; i++){
                let buf;
                try{
                    buf = await store.get("song/" + fileId + "/" + pad3(i), { type: "arrayBuffer", consistency: "strong" });
                }catch(e){ return json({ ok: false, error: "BLOB_GET_FAIL" }, 500); }
                if(buf === null) return json({ ok: false, error: "NOT_FOUND" }, 404);
                parts.push(new Uint8Array(buf));
            }
            const need = new Uint8Array(end - start + 1);
            let off = first * CHUNK;
            let pos = 0;
            for(const p of parts){
                const gs = Math.max(start, off);
                const ge = Math.min(end, off + p.length - 1);
                need.set(p.subarray(gs - off, ge - off + 1), pos);
                pos += ge - gs + 1;
                off += p.length;
            }
            if(m){
                return new Response(need, {
                    status: 206,
                    headers: Object.assign({}, baseHeaders, { "content-range": "bytes " + start + "-" + end + "/" + total })
                });
            }
            return new Response(need, { headers: baseHeaders });
        }
        if(lrcId){
            let data;
            try{
                data = await store.get("song/" + lrcId + ".lrc", { consistency: "strong" });
            }catch(e){ return json({ ok: false, error: "BLOB_GET_FAIL" }, 500); }
            if(data === null) return json({ ok: false, error: "NOT_FOUND" }, 404);
            return new Response(data, {
                headers: { "content-type": "text/plain; charset=utf-8", "access-control-allow-origin": "*" }
            });
        }
        return json({ ok: true, songs: await metaList(store, "meta/song/") });
    }

    if(request.method === "POST"){
        const mode = url.searchParams.get("mode");
        // mode=init：按大小生成分块直传地址列表
        if(mode === "init"){
            let body = null;
            try{ body = await request.json(); }catch(e){}
            const size = Number(body && body.size) || 0;
            if(size <= 0) return json({ ok: false, error: "NO_MP3" }, 400);
            if(size > 50 * 1024 * 1024) return json({ ok: false, error: "MP3_TOO_LARGE" }, 400);
            const n = Math.min(64, Math.ceil(size / CHUNK));
            const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
            try{
                const urls = [];
                for(let i = 0; i < n; i++){
                    const up = await store.createUploadUrl("song/" + id + "/" + pad3(i), { contentType: "application/octet-stream", expireSeconds: 3600 });
                    urls.push(up.url);
                }
                return json({ ok: true, id: id, urls: urls });
            }catch(e){ return json({ ok: false, error: "UPLOAD_URL_FAIL" }, 500); }
        }
        // mode=finish：直传完成后校验并登记元数据（lrc 文本随 JSON 带上）
        if(mode === "finish"){
            let body = null;
            try{ body = await request.json(); }catch(e){}
            const id = String((body && body.id) || "");
            if(!/^[a-z0-9]+$/.test(id)) return json({ ok: false, error: "BAD_ID" }, 400);
            const nChunks = parseInt((body && body.chunks), 10) || 0;
            const size = parseInt((body && body.size), 10) || 0;
            if(!(nChunks > 0 && nChunks <= 64) || !(size > 0)) return json({ ok: false, error: "BAD_META" }, 400);
            try{
                const md = await store.getMetadata("song/" + id + "/" + pad3(0), { consistency: "strong" });
                if(!md) return json({ ok: false, error: "UPLOAD_NOT_FOUND" }, 400);
            }catch(e){ return json({ ok: false, error: "UPLOAD_NOT_FOUND" }, 400); }
            let hasLrc = false;
            const lrcText = String((body && body.lrc) || "");
            if(lrcText && lrcText.length < 200 * 1024){
                try{ await store.set("song/" + id + ".lrc", lrcText); hasLrc = true; }catch(e){}
            }
            const rawName = String((body && body.name) || "未命名").replace(/\.mp3$/i, "");
            const meta = { id: id, name: rawName.slice(0, 50), size: size, chunks: nChunks, hasLrc: hasLrc, ts: Date.now() };
            try{ await store.set("meta/song/" + id, JSON.stringify(meta)); }catch(e){ return json({ ok: false, error: "SAVE_FAIL" }, 500); }
            return json({ ok: true, song: meta });
        }
        // mode=del：删除歌曲（分块 + 歌词 + 元数据，兼容旧格式单对象）
        if(mode === "del"){
            let body = null;
            try{ body = await request.json(); }catch(e){}
            const id = String((body && body.id) || "");
            if(!/^[a-z0-9]+$/.test(id)) return json({ ok: false, error: "BAD_ID" }, 400);
            let meta = null;
            try{
                const mv = await store.get("meta/song/" + id, { consistency: "strong" });
                meta = mv ? JSON.parse(mv) : null;
            }catch(e){}
            const keys = [];
            if(meta && meta.chunks){
                for(let i = 0; i < meta.chunks; i++) keys.push("song/" + id + "/" + pad3(i));
            }else{
                try{
                    const res = await store.list({ prefix: "song/" + id + "/", consistency: "strong" });
                    for(const b of (res.blobs || [])) keys.push(b.key);
                }catch(e){}
                keys.push("song/" + id + ".mp3");
                keys.push("song/" + id + ".lrc");
            }
            for(const k of keys){ try{ await store.delete(k); }catch(e){} }
            try{ await store.delete("meta/song/" + id); }catch(e){}
            return json({ ok: true });
        }
        return json({ ok: false, error: "UNKNOWN_MODE" }, 400);
    }

    return json({ ok: false, error: "METHOD_NOT_ALLOWED" }, 405);
}
