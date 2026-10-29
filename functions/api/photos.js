// 照片接口：GET 列表 / GET ?id=xx 取图 / POST 上传(multipart, 字段名 files)
// 元数据存 KV(NOTES_KV, 前缀 photo:)，图片二进制存 Blob（新版走 SDK @edgeone/pages-blob 的 media 库，键 photo/<id>）

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
function getKV(env){ return (env && (env.NOTES_KV || env.KV)) || null; }
// Blob：新版 Makers 控制台用官方 SDK（自动创建、自动鉴权）；旧绑定 env.BLOB 作兼容回退
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
async function getBlob(env){
    const legacy = (env && (env.BLOB || env.MEDIA_BLOB || env.BLOBS)) || null;
    if(legacy && typeof legacy.put === "function" && typeof legacy.get === "function") return legacy;
    return await loadStore();
}
function isSdkStore(b){ return typeof b.set === "function"; }
async function blobPut(b, key, val){
    if(isSdkStore(b)){ await b.set(key, val); return; }
    await b.put(key, val);
}
async function blobGetBin(b, key){
    if(isSdkStore(b)) return await b.get(key, { type: "arrayBuffer", consistency: "strong" });
    const v = await b.get(key);
    if(v === undefined || v === null) return null;
    if(typeof v === "string") return v;
    if(v instanceof ArrayBuffer || v instanceof Uint8Array) return v;
    if(typeof v.arrayBuffer === "function") return await v.arrayBuffer();
    if(v.body) return v.body;
    return v;
}
async function listMeta(kv, prefix){
    const out = [];
    let cursor;
    for(let i = 0; i < 10; i++){
        const opt = { prefix: prefix, limit: 100 };
        if(cursor) opt.cursor = cursor;
        const page = await kv.list(opt);
        const keys = (page && page.keys) ? page.keys : [];
        for(const k of keys){
            const v = await kv.get(k.name);
            if(v){ try{ out.push(JSON.parse(v)); }catch(e){} }
        }
        if(!page || page.list_complete === true || !page.cursor) break;
        cursor = page.cursor;
    }
    out.sort((a, b) => (a.ts || 0) - (b.ts || 0));
    return out;
}

export async function onRequest({ request, env }){
    if(request.method === "OPTIONS") return json({ ok: true });

    const kv = getKV(env);
    if(!kv) return json({ ok: false, error: "KV_NOT_BOUND" }, 500);

    const url = new URL(request.url);
    const id = url.searchParams.get("id");
    const blob = await getBlob(env);

    if(request.method === "GET"){
        if(id){
            if(!blob) return json({ ok: false, error: "BLOB_NOT_BOUND" }, 500);
            let type = "image/jpeg";
            const metaRaw = await kv.get("photo:" + id);
            if(metaRaw){ try{ type = JSON.parse(metaRaw).type || type; }catch(e){} }
            let data;
            try{ data = await blobGetBin(blob, "photo/" + id); }catch(e){ return json({ ok: false, error: "BLOB_GET_FAIL" }, 500); }
            if(data === null) return json({ ok: false, error: "NOT_FOUND" }, 404);
            return new Response(data, {
                headers: { "content-type": type, "cache-control": "public, max-age=86400", "access-control-allow-origin": "*" }
            });
        }
        return json({ ok: true, photos: await listMeta(kv, "photo:") });
    }

    if(request.method === "POST"){
        if(!blob) return json({ ok: false, error: "BLOB_NOT_BOUND" }, 500);
        let form;
        try{ form = await request.formData(); }catch(e){ return json({ ok: false, error: "BAD_FORM" }, 400); }
        const files = form.getAll("files").filter(f => f && typeof f === "object" && f.size > 0);
        if(files.length === 0) return json({ ok: false, error: "NO_FILES" }, 400);
        const saved = [];
        for(const f of files){
            if(f.size > 10 * 1024 * 1024) continue;
            const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
            try{
                const buf = await f.arrayBuffer();
                await blobPut(blob, "photo/" + id, buf);
            }catch(e){ continue; }
            const meta = { id: id, name: String(f.name || "").slice(0, 50), type: f.type || "image/jpeg", ts: Date.now() };
            await kv.put("photo:" + id, JSON.stringify(meta));
            saved.push(meta);
        }
        if(saved.length === 0) return json({ ok: false, error: "SAVE_FAIL" }, 500);
        return json({ ok: true, saved: saved });
    }

    return json({ ok: false, error: "METHOD_NOT_ALLOWED" }, 405);
}
