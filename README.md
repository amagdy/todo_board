# Task Board
Local Flask task board: projects → unlimited nested tasks, markdown descriptions, tags, resources (files/links), drag & drop priority, progress roll-up.

## Run
    uv venv .venv && uv pip install -p .venv/bin/python -r requirements.txt   # or: python -m venv .venv && pip install -r requirements.txt
    .venv/bin/python app.py        # http://127.0.0.1:5000  (PORT=… to change)

## Data
SQLite DB + uploaded files live in a separate folder, `../todo_board_data` by default (override with `TODO_BOARD_DATA`).
It is auto-created and `git init`-ed. The **Backup** button commits it (nothing is committed if nothing changed).

## Using it
- Click any title to edit it in place; click a description to edit its Markdown.
- Drag a task by ⋮⋮: top/bottom edge of another row = reorder, middle = nest inside it.
- Search/tag chips filter the task list; ✎ opens a task's own screen (its own subtasks and resources).
- A task's/project's Resources include everything attached to all its subtasks (with a "from" link).
