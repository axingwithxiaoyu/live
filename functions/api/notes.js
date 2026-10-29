// 留言接口：GET /api/notes 拉取共享留言，POST /api/notes 提交留言
// 存储走新版 Blob SDK（@edgeone/pages-blob，media 库，控制台自动创建、无需手动绑定），键 note/<id>

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

async function listNotes(store){
    const out = [];
    const res = await store.list({ prefix: "note/", consistency: "strong" });
    for(const b of (res.blobs || [])){
        const id = b.key.slice("note/".length);
        if(!id) continue;
        try{
            const v = await store.get(b.key, { consistency: "strong" });
            if(v){
                const n = JSON.parse(v);
                if(!n.id) n.id = id;
                out.push(n);
            }
        }catch(e){}
    }
    out.sort((a, b) => (b.ts || 0) - (a.ts || 0));
    return out.slice(0, 500);
}

export async function onRequest({ request }){
    if(request.method === "OPTIONS") return json({ ok: true });

    const store = await loadStore();
    if(!store){
        return json({ ok: false, error: "BLOB_NOT_READY", hint: "Blob 存储未就绪，请确认部署在 EdgeOne 上" }, 500);
    }

    if(request.method === "GET"){
        try{
            const notes = await listNotes(store);
            return json({ ok: true, notes: notes });
        }catch(e){
            return json({ ok: false, error: "LIST_FAIL" }, 500);
        }
    }

    if(request.method === "POST"){
        let body = null;
        try { body = await request.json(); } catch(e) {}
        const name = String((body && body.name) || "").trim().slice(0, 20) || "匿名";
        const text = String((body && body.text) || "").trim().slice(0, 200);
        if(!text) return json({ ok: false, error: "EMPTY" }, 400);
        const note = {
            id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
            name: name,
            text: text,
            ts: Date.now()
        };
        try{
            await store.set("note/" + note.id, JSON.stringify(note));
        }catch(e){
            return json({ ok: false, error: "SAVE_FAIL" }, 500);
        }
        return json({ ok: true, note: note });
    }

    return json({ ok: false, error: "METHOD_NOT_ALLOWED" }, 405);
}
