// 歌曲接口：GET 列表 / GET ?file=id 取音频 / GET ?lrc=id 取歌词 / POST 上传(mp3必选 + 可选lrc)
// 元数据存 KV(NOTES_KV, 前缀 song:)，音频和歌词存 Blob(BLOB, 键 song/<id>.mp3 / song/<id>.lrc)

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
function getBlob(env){
    const b = (env && (env.BLOB || env.MEDIA_BLOB || env.BLOBS)) || null;
    if(!b || typeof b.put !== "function" || typeof b.get !== "function") return null;
    return b;
}
async function blobGet(b, key){
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
    const fileId = url.searchParams.get("file");
    const lrcId = url.searchParams.get("lrc");
    const blob = getBlob(env);

    if(request.method === "GET"){
        if(fileId){
            if(!blob) return json({ ok: false, error: "BLOB_NOT_BOUND" }, 500);
            const data = await blobGet(blob, "song/" + fileId + ".mp3");
            if(data === null) return json({ ok: false, error: "NOT_FOUND" }, 404);
            return new Response(data, {
                headers: { "content-type": "audio/mpeg", "cache-control": "public, max-age=86400", "access-control-allow-origin": "*" }
            });
        }
        if(lrcId){
            if(!blob) return json({ ok: false, error: "BLOB_NOT_BOUND" }, 500);
            const data = await blobGet(blob, "song/" + lrcId + ".lrc");
            if(data === null) return json({ ok: false, error: "NOT_FOUND" }, 404);
            return new Response(data, {
                headers: { "content-type": "text/plain; charset=utf-8", "access-control-allow-origin": "*" }
            });
        }
        return json({ ok: true, songs: await listMeta(kv, "song:") });
    }

    if(request.method === "POST"){
        if(!blob) return json({ ok: false, error: "BLOB_NOT_BOUND" }, 500);
        let form;
        try{ form = await request.formData(); }catch(e){ return json({ ok: false, error: "BAD_FORM" }, 400); }
        const mp3 = form.get("mp3");
        if(!mp3 || typeof mp3 === "string" || mp3.size === 0) return json({ ok: false, error: "NO_MP3" }, 400);
        if(mp3.size > 30 * 1024 * 1024) return json({ ok: false, error: "MP3_TOO_LARGE" }, 400);
        const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        try{
            const buf = await mp3.arrayBuffer();
            await blob.put("song/" + id + ".mp3", buf);
        }catch(e){ return json({ ok: false, error: "BLOB_PUT_FAIL" }, 500); }
        let hasLrc = false;
        const lrc = form.get("lrc");
        if(lrc && typeof lrc !== "string" && lrc.size > 0 && lrc.size < 200 * 1024){
            try{
                const text = await lrc.text();
                await blob.put("song/" + id + ".lrc", text);
                hasLrc = true;
            }catch(e){}
        }
        const rawName = String(mp3.name || "未命名").replace(/\.mp3$/i, "");
        const meta = { id: id, name: rawName.slice(0, 50), hasLrc: hasLrc, ts: Date.now() };
        await kv.put("song:" + id, JSON.stringify(meta));
        return json({ ok: true, song: meta });
    }

    return json({ ok: false, error: "METHOD_NOT_ALLOWED" }, 405);
}
