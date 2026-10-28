// 留言接口：GET /api/notes 拉取共享留言，POST /api/notes 提交留言
// 需要在 EdgeOne Pages 项目设置中绑定 KV 命名空间，变量名 NOTES_KV

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

function getKV(env){
    return (env && (env.NOTES_KV || env.KV)) || null;
}

async function listNotes(kv){
    const out = [];
    let cursor = undefined;
    for(let i = 0; i < 10; i++){
        const opt = { prefix: "note:", limit: 100 };
        if(cursor) opt.cursor = cursor;
        const page = await kv.list(opt);
        const keys = (page && page.keys) ? page.keys : [];
        for(const k of keys){
            const v = await kv.get(k.name);
            if(v){
                try { out.push(JSON.parse(v)); } catch(e) {}
            }
        }
        if(!page || page.list_complete === true || !page.cursor) break;
        cursor = page.cursor;
    }
    out.sort((a, b) => (b.ts || 0) - (a.ts || 0));
    return out.slice(0, 500);
}

export async function onRequest({ request, env }){
    if(request.method === "OPTIONS") return json({ ok: true });

    const kv = getKV(env);
    if(!kv){
        return json({ ok: false, error: "KV_NOT_BOUND", hint: "请在EdgeOne Pages项目设置中绑定KV命名空间，变量名NOTES_KV" }, 500);
    }

    if(request.method === "GET"){
        try{
            const notes = await listNotes(kv);
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
            await kv.put("note:" + note.id, JSON.stringify(note));
        }catch(e){
            return json({ ok: false, error: "SAVE_FAIL" }, 500);
        }
        return json({ ok: true, note: note });
    }

    return json({ ok: false, error: "METHOD_NOT_ALLOWED" }, 405);
}
