"""Task Board - a local Flask website for projects, nested tasks and resources.

Data (SQLite DB + uploaded files) lives in a separate, git-controlled folder
(default: ../todo_board_data, override with TODO_BOARD_DATA). The "Backup"
button commits that folder.
"""
import os
import random
import sqlite3
import subprocess
import uuid
from datetime import date, datetime
from pathlib import Path

from flask import (Flask, abort, g, jsonify, render_template, request,
                   send_file)
from werkzeug.utils import secure_filename

APP_DIR = Path(__file__).resolve().parent
DATA_DIR = Path(os.environ.get("TODO_BOARD_DATA", APP_DIR.parent / "todo_board_data")).resolve()
FILES_DIR = DATA_DIR / "files"
DB_PATH = DATA_DIR / "taskboard.db"

SCHEMA = """
CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_type TEXT NOT NULL CHECK (task_type IN ('project','task')),
    title TEXT NOT NULL CHECK (length(trim(title)) > 0),
    description TEXT,
    parent_task_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
    position INTEGER NOT NULL DEFAULT 0,
    due_date TEXT,
    estimate_value REAL,
    estimate_unit TEXT NOT NULL DEFAULT 'days' CHECK (estimate_unit IN ('days','hours')),
    done INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS resources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    resource_type TEXT NOT NULL CHECK (resource_type IN ('file','link')),
    path TEXT NOT NULL,           -- file: path relative to data dir; link: URL
    description TEXT,
    original_name TEXT,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    color TEXT NOT NULL DEFAULT '#6c757d'
);
CREATE TABLE IF NOT EXISTS task_tags (
    task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (task_id, tag_id)
);
CREATE TABLE IF NOT EXISTS resource_tags (
    resource_id INTEGER NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
    tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (resource_id, tag_id)
);
CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_task_id, position);
CREATE INDEX IF NOT EXISTS idx_resources_task ON resources(task_id);
"""

PALETTE = ["#e5484d", "#f76b15", "#e5a50a", "#30a46c", "#12a594",
           "#0090ff", "#3e63dd", "#8e4ec6", "#d6409f", "#6c757d"]

app = Flask(__name__)


# --------------------------------------------------------------------- setup
def git(*args, check=True):
    return subprocess.run(
        ["git", "-C", str(DATA_DIR), *args],
        capture_output=True, text=True, check=check)


def init_data_dir():
    FILES_DIR.mkdir(parents=True, exist_ok=True)
    if not (DATA_DIR / ".git").exists():
        git("init", "-q")
    keep = FILES_DIR / ".gitkeep"
    if not keep.exists():
        keep.touch()
    db = sqlite3.connect(DB_PATH)
    db.executescript(SCHEMA)
    db.commit()
    db.close()


def get_db():
    if "db" not in g:
        g.db = sqlite3.connect(DB_PATH)
        g.db.row_factory = sqlite3.Row
        g.db.execute("PRAGMA foreign_keys = ON")
    return g.db


@app.teardown_appcontext
def close_db(_exc):
    db = g.pop("db", None)
    if db is not None:
        db.close()


def now():
    return datetime.now().isoformat(timespec="seconds")


def err(msg, code=400):
    resp = jsonify(error=msg)
    resp.status_code = code
    return resp


# ------------------------------------------------------------------- helpers
def row_task(r):
    return {
        "id": r["id"], "task_type": r["task_type"], "title": r["title"],
        "description": r["description"] or "", "parent_task_id": r["parent_task_id"],
        "position": r["position"], "due_date": r["due_date"],
        "estimate_value": r["estimate_value"], "estimate_unit": r["estimate_unit"],
        "done": bool(r["done"]),
    }


def load_forest():
    """Load all tasks into memory: returns (nodes_by_id, children_by_parent)."""
    db = get_db()
    nodes, children = {}, {}
    tag_map = {}
    for r in db.execute("SELECT tt.task_id, t.id, t.name, t.color FROM task_tags tt "
                        "JOIN tags t ON t.id = tt.tag_id ORDER BY t.name"):
        tag_map.setdefault(r["task_id"], []).append(
            {"id": r["id"], "name": r["name"], "color": r["color"]})
    for r in db.execute("SELECT * FROM tasks ORDER BY position, id"):
        n = row_task(r)
        n["tags"] = tag_map.get(n["id"], [])
        nodes[n["id"]] = n
        children.setdefault(n["parent_task_id"], []).append(n["id"])
    return nodes, children


def descendants(children, tid):
    out, stack = [], list(children.get(tid, []))
    while stack:
        i = stack.pop()
        out.append(i)
        stack.extend(children.get(i, []))
    return out


def build_tree(nodes, children, tid):
    n = dict(nodes[tid])
    n["children"] = [build_tree(nodes, children, c) for c in children.get(tid, [])]
    desc = descendants(children, tid)
    n["progress"] = {"done": sum(1 for d in desc if nodes[d]["done"]), "total": len(desc)}
    return n


def tags_for_names(db, names):
    """Resolve tag names to ids, creating missing tags with a palette colour."""
    ids = []
    for raw in names:
        name = (raw or "").strip().lstrip("#")
        if not name:
            continue
        row = db.execute("SELECT id FROM tags WHERE name = ?", (name,)).fetchone()
        if row is None:
            cur = db.execute("INSERT INTO tags(name, color) VALUES (?,?)",
                             (name, random.choice(PALETTE)))
            ids.append(cur.lastrowid)
        else:
            ids.append(row["id"])
    return list(dict.fromkeys(ids))


def resource_dict(db, r, titles=None):
    tags = [dict(t) for t in db.execute(
        "SELECT t.id, t.name, t.color FROM resource_tags rt JOIN tags t ON t.id = rt.tag_id "
        "WHERE rt.resource_id = ? ORDER BY t.name", (r["id"],))]
    return {
        "id": r["id"], "task_id": r["task_id"], "resource_type": r["resource_type"],
        "path": r["path"], "description": r["description"] or "",
        "name": r["original_name"] or r["path"], "tags": tags,
        "task_title": (titles or {}).get(r["task_id"]),
    }


def parse_task_fields(data, partial):
    """Validate editable task fields. Returns (fields_dict, error)."""
    f = {}
    if "title" in data or not partial:
        title = (data.get("title") or "").strip()
        if not title:
            return None, "Title is required"
        f["title"] = title
    if "description" in data:
        f["description"] = data["description"] or None
    if "due_date" in data:
        v = data["due_date"]
        if v in (None, ""):
            f["due_date"] = None
        else:
            try:
                f["due_date"] = date.fromisoformat(v).isoformat()
            except (ValueError, TypeError):
                return None, "Invalid due date"
    if "estimate_value" in data:
        v = data["estimate_value"]
        if v in (None, ""):
            f["estimate_value"] = None
        else:
            try:
                v = float(v)
            except (ValueError, TypeError):
                return None, "Invalid estimate"
            if v < 0:
                return None, "Estimate must be positive"
            f["estimate_value"] = v
    if "estimate_unit" in data:
        if data["estimate_unit"] not in ("days", "hours"):
            return None, "Invalid estimate unit"
        f["estimate_unit"] = data["estimate_unit"]
    if "done" in data:
        f["done"] = 1 if data["done"] else 0
    return f, None


def remove_files(paths):
    for p in paths:
        try:
            (DATA_DIR / p).unlink()
        except OSError:
            pass


# --------------------------------------------------------------------- pages
@app.route("/")
def index_page():
    return render_template("index.html")


@app.route("/task/<int:tid>")
def task_page(tid):
    if get_db().execute("SELECT 1 FROM tasks WHERE id=?", (tid,)).fetchone() is None:
        abort(404)
    return render_template("task.html", task_id=tid)


# ---------------------------------------------------------------- tasks API
@app.get("/api/projects")
def api_projects():
    nodes, children = load_forest()
    out = []
    for tid in children.get(None, []):
        t = build_tree(nodes, children, tid)
        t.pop("children")
        out.append(t)
    return jsonify(out)


@app.get("/api/task/<int:tid>")
def api_task(tid):
    nodes, children = load_forest()
    if tid not in nodes:
        return err("Not found", 404)
    tree = build_tree(nodes, children, tid)
    crumbs, p = [], nodes[tid]["parent_task_id"]
    while p is not None:
        crumbs.insert(0, {"id": p, "title": nodes[p]["title"], "task_type": nodes[p]["task_type"]})
        p = nodes[p]["parent_task_id"]
    ids = [tid] + descendants(children, tid)
    db = get_db()
    q = ",".join("?" * len(ids))
    titles = {i: nodes[i]["title"] for i in ids}
    res = [resource_dict(db, r, titles) for r in db.execute(
        f"SELECT * FROM resources WHERE task_id IN ({q}) ORDER BY id", ids)]
    return jsonify(task=tree, breadcrumbs=crumbs, resources=res)


@app.post("/api/tasks")
def api_create_task():
    data = request.get_json(force=True)
    fields, e = parse_task_fields(data, partial=False)
    if e:
        return err(e)
    db = get_db()
    parent = data.get("parent_task_id")
    if parent is None:
        ttype = "project"
    else:
        if db.execute("SELECT 1 FROM tasks WHERE id=?", (parent,)).fetchone() is None:
            return err("Parent not found", 404)
        ttype = "task"
    pos = db.execute("SELECT COALESCE(MAX(position), -1) + 1 FROM tasks WHERE parent_task_id IS ?",
                     (parent,)).fetchone()[0]
    cur = db.execute(
        "INSERT INTO tasks(task_type, title, description, parent_task_id, position, due_date,"
        " estimate_value, estimate_unit, done, created_at) VALUES (?,?,?,?,?,?,?,?,0,?)",
        (ttype, fields["title"], fields.get("description"), parent, pos, fields.get("due_date"),
         fields.get("estimate_value"), fields.get("estimate_unit", "days"), now()))
    tid = cur.lastrowid
    if data.get("tags"):
        for tag_id in tags_for_names(db, data["tags"]):
            db.execute("INSERT INTO task_tags VALUES (?,?)", (tid, tag_id))
    db.commit()
    return jsonify(id=tid), 201


@app.patch("/api/tasks/<int:tid>")
def api_update_task(tid):
    fields, e = parse_task_fields(request.get_json(force=True), partial=True)
    if e:
        return err(e)
    if fields:
        db = get_db()
        sets = ", ".join(f"{k} = ?" for k in fields)
        cur = db.execute(f"UPDATE tasks SET {sets} WHERE id = ?", [*fields.values(), tid])
        if cur.rowcount == 0:
            return err("Not found", 404)
        db.commit()
    return jsonify(ok=True)


@app.delete("/api/tasks/<int:tid>")
def api_delete_task(tid):
    nodes, children = load_forest()
    if tid not in nodes:
        return err("Not found", 404)
    ids = [tid] + descendants(children, tid)
    db = get_db()
    q = ",".join("?" * len(ids))
    files = [r["path"] for r in db.execute(
        f"SELECT path FROM resources WHERE resource_type='file' AND task_id IN ({q})", ids)]
    db.execute("DELETE FROM tasks WHERE id = ?", (tid,))  # cascades
    db.commit()
    remove_files(files)
    return jsonify(ok=True, parent_task_id=nodes[tid]["parent_task_id"])


@app.post("/api/tasks/<int:tid>/move")
def api_move_task(tid):
    data = request.get_json(force=True)
    nodes, children = load_forest()
    new_parent, index = data.get("parent_task_id"), int(data.get("index", 10**9))
    if tid not in nodes or nodes[tid]["task_type"] == "project":
        return err("Cannot move this item")
    if new_parent not in nodes:
        return err("Parent not found", 404)
    if new_parent == tid or new_parent in descendants(children, tid):
        return err("Cannot move a task into itself")
    siblings = [i for i in children.get(new_parent, []) if i != tid]
    index = max(0, min(index, len(siblings)))
    siblings.insert(index, tid)
    db = get_db()
    db.execute("UPDATE tasks SET parent_task_id = ? WHERE id = ?", (new_parent, tid))
    for pos, i in enumerate(siblings):
        db.execute("UPDATE tasks SET position = ? WHERE id = ?", (pos, i))
    db.commit()
    return jsonify(ok=True)


@app.put("/api/tasks/<int:tid>/tags")
def api_set_task_tags(tid):
    db = get_db()
    if db.execute("SELECT 1 FROM tasks WHERE id=?", (tid,)).fetchone() is None:
        return err("Not found", 404)
    ids = tags_for_names(db, request.get_json(force=True).get("tags", []))
    db.execute("DELETE FROM task_tags WHERE task_id = ?", (tid,))
    for i in ids:
        db.execute("INSERT INTO task_tags VALUES (?,?)", (tid, i))
    db.commit()
    return jsonify(ok=True)


# ----------------------------------------------------------------- tags API
@app.get("/api/tags")
def api_tags():
    return jsonify([dict(r) for r in get_db().execute(
        "SELECT id, name, color FROM tags ORDER BY name")])


@app.patch("/api/tags/<int:tag_id>")
def api_update_tag(tag_id):
    data = request.get_json(force=True)
    db = get_db()
    try:
        if "name" in data:
            name = (data["name"] or "").strip()
            if not name:
                return err("Tag name is required")
            db.execute("UPDATE tags SET name = ? WHERE id = ?", (name, tag_id))
        if "color" in data:
            db.execute("UPDATE tags SET color = ? WHERE id = ?", (data["color"], tag_id))
        db.commit()
    except sqlite3.IntegrityError:
        return err("A tag with that name already exists")
    return jsonify(ok=True)


@app.delete("/api/tags/<int:tag_id>")
def api_delete_tag(tag_id):
    db = get_db()
    db.execute("DELETE FROM tags WHERE id = ?", (tag_id,))
    db.commit()
    return jsonify(ok=True)


# ------------------------------------------------------------ resources API
@app.post("/api/tasks/<int:tid>/resources")
def api_add_resource(tid):
    db = get_db()
    if db.execute("SELECT 1 FROM tasks WHERE id=?", (tid,)).fetchone() is None:
        return err("Not found", 404)
    if request.files.get("file"):
        up = request.files["file"]
        original = secure_filename(up.filename or "") or "file"
        rel = f"files/{uuid.uuid4().hex[:12]}_{original}"
        up.save(DATA_DIR / rel)
        rtype, path, desc = "file", rel, request.form.get("description", "").strip()
    else:
        data = request.get_json(silent=True) or request.form
        url = (data.get("url") or "").strip()
        if not url:
            return err("A file or a URL is required")
        if "://" not in url:
            url = "https://" + url
        rtype, path, original = "link", url, url
        desc = (data.get("description") or "").strip()
    cur = db.execute(
        "INSERT INTO resources(task_id, resource_type, path, description, original_name, created_at)"
        " VALUES (?,?,?,?,?,?)", (tid, rtype, path, desc or None, original, now()))
    db.commit()
    return jsonify(id=cur.lastrowid), 201


@app.patch("/api/resources/<int:rid>")
def api_update_resource(rid):
    data = request.get_json(force=True)
    db = get_db()
    if "description" in data:
        db.execute("UPDATE resources SET description = ? WHERE id = ?",
                   ((data["description"] or "").strip() or None, rid))
    db.commit()
    return jsonify(ok=True)


@app.put("/api/resources/<int:rid>/tags")
def api_set_resource_tags(rid):
    db = get_db()
    ids = tags_for_names(db, request.get_json(force=True).get("tags", []))
    db.execute("DELETE FROM resource_tags WHERE resource_id = ?", (rid,))
    for i in ids:
        db.execute("INSERT INTO resource_tags VALUES (?,?)", (rid, i))
    db.commit()
    return jsonify(ok=True)


@app.delete("/api/resources/<int:rid>")
def api_delete_resource(rid):
    db = get_db()
    r = db.execute("SELECT * FROM resources WHERE id = ?", (rid,)).fetchone()
    if r is None:
        return err("Not found", 404)
    db.execute("DELETE FROM resources WHERE id = ?", (rid,))
    db.commit()
    if r["resource_type"] == "file":
        remove_files([r["path"]])
    return jsonify(ok=True)


@app.get("/resources/<int:rid>/download")
def download_resource(rid):
    r = get_db().execute("SELECT * FROM resources WHERE id = ? AND resource_type='file'",
                         (rid,)).fetchone()
    if r is None:
        abort(404)
    path = (DATA_DIR / r["path"]).resolve()
    if FILES_DIR not in path.parents or not path.is_file():
        abort(404)
    return send_file(path, as_attachment=True, download_name=r["original_name"])


# ------------------------------------------------------------------- backup
@app.post("/api/backup")
def api_backup():
    try:
        git("add", "-A")
        if not git("status", "--porcelain").stdout.strip():
            return jsonify(committed=False, message="Nothing changed since the last backup.")
        msg = f"Backup {datetime.now():%Y-%m-%d %H:%M:%S}"
        # Fallback identity so the commit works even without a global git config.
        git("-c", "user.name=Task Board", "-c", "user.email=taskboard@localhost",
            "commit", "-q", "-m", msg)
        sha = git("rev-parse", "--short", "HEAD").stdout.strip()
        return jsonify(committed=True, message=f"Backup committed ({sha}).")
    except subprocess.CalledProcessError as e:
        return err(f"git failed: {(e.stderr or e.stdout).strip()}", 500)


init_data_dir()

if __name__ == "__main__":
    print(f"Data folder: {DATA_DIR}")
    app.run(host="127.0.0.1", port=int(os.environ.get("PORT", 5000)), debug=False)
