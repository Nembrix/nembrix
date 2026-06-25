//! Native menu bar.
//!
//! Every leaf item carries a stable id like `file.new_connection` and emits
//! a `menu:invoke` event to the focused webview with that id as payload.
//! The frontend's `useMenu()` hook dispatches the id to a handler. We keep
//! the menu *declaration* here in Rust because Tauri owns the OS-level
//! integration, but the *behavior* lives in TypeScript so it works
//! identically in `npm run dev` (mock) and `cargo tauri dev` (native).

use tauri::menu::{
    AboutMetadataBuilder, Menu, MenuBuilder, MenuItemBuilder, PredefinedMenuItem, Submenu,
    SubmenuBuilder,
};
use tauri::{AppHandle, Emitter, Manager, Runtime};

/// Event name the frontend listens on.
pub const MENU_EVENT: &str = "menu:invoke";

/// Build and install the application menu.
pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let pkg = app.package_info();
    let about = AboutMetadataBuilder::new()
        .name(Some(pkg.name.clone()))
        .version(Some(pkg.version.to_string()))
        .copyright(Some::<String>("MIT OR Apache-2.0".into()))
        .build();

    let app_menu: Submenu<R> = SubmenuBuilder::new(app, &pkg.name)
        .item(&PredefinedMenuItem::about(app, Some("About"), Some(about))?)
        .separator()
        .item(
            &MenuItemBuilder::with_id("app.preferences", "Preferences…")
                .accelerator("CmdOrCtrl+,")
                .build(app)?,
        )
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;

    let file_menu: Submenu<R> = SubmenuBuilder::new(app, "File")
        .item(
            &MenuItemBuilder::with_id("file.new_connection", "New Connection…")
                .accelerator("CmdOrCtrl+N")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("file.new_query_tab", "New Query Tab")
                .accelerator("CmdOrCtrl+T")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("file.new_window", "New Window")
                .accelerator("CmdOrCtrl+Shift+N")
                .build(app)?,
        )
        .separator()
        .item(
            &MenuItemBuilder::with_id("file.open_saved_query", "Open Saved Query…")
                .accelerator("CmdOrCtrl+O")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("file.save_query", "Save Query")
                .accelerator("CmdOrCtrl+S")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("file.save_query_as", "Save Query As…")
                .accelerator("CmdOrCtrl+Shift+S")
                .build(app)?,
        )
        .separator()
        .item(&MenuItemBuilder::with_id("file.import", "Import…").build(app)?)
        .item(&MenuItemBuilder::with_id("file.export", "Export…").build(app)?)
        .separator()
        .item(
            &MenuItemBuilder::with_id("file.close_tab", "Close Tab")
                .accelerator("CmdOrCtrl+W")
                .build(app)?,
        )
        .item(&PredefinedMenuItem::close_window(
            app,
            Some("Close Window"),
        )?)
        .build()?;

    let edit_menu: Submenu<R> = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .separator()
        .item(
            &MenuItemBuilder::with_id("edit.find", "Find…")
                .accelerator("CmdOrCtrl+F")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("edit.find_next", "Find Next")
                .accelerator("CmdOrCtrl+G")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("edit.replace", "Find & Replace…")
                .accelerator("CmdOrCtrl+Alt+F")
                .build(app)?,
        )
        .build()?;

    let view_menu: Submenu<R> = SubmenuBuilder::new(app, "View")
        .item(
            &MenuItemBuilder::with_id("view.command_palette", "Command Palette…")
                .accelerator("CmdOrCtrl+P")
                .build(app)?,
        )
        .separator()
        .item(
            &MenuItemBuilder::with_id("view.toggle_rail", "Toggle Connection Rail")
                .accelerator("CmdOrCtrl+0")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("view.toggle_inspector", "Toggle Inspector")
                .accelerator("CmdOrCtrl+1")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("view.toggle_results", "Toggle Results Pane")
                .accelerator("CmdOrCtrl+2")
                .build(app)?,
        )
        .separator()
        .item(
            &MenuItemBuilder::with_id("view.next_tab", "Next Tab")
                .accelerator("Ctrl+Tab")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("view.prev_tab", "Previous Tab")
                .accelerator("Ctrl+Shift+Tab")
                .build(app)?,
        )
        .separator()
        .fullscreen()
        .build()?;

    let connection_menu: Submenu<R> = SubmenuBuilder::new(app, "Connection")
        .item(
            &MenuItemBuilder::with_id("conn.manage", "Manage Connections…")
                .accelerator("CmdOrCtrl+Shift+L")
                .build(app)?,
        )
        .separator()
        .item(
            &MenuItemBuilder::with_id("conn.connect", "Connect")
                .accelerator("CmdOrCtrl+K")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("conn.disconnect", "Disconnect")
                .accelerator("CmdOrCtrl+Shift+K")
                .build(app)?,
        )
        .separator()
        .item(&MenuItemBuilder::with_id("conn.edit", "Edit Connection…").build(app)?)
        .item(&MenuItemBuilder::with_id("conn.duplicate", "Duplicate Connection").build(app)?)
        .item(&MenuItemBuilder::with_id("conn.delete", "Delete Connection").build(app)?)
        .separator()
        .item(
            &MenuItemBuilder::with_id("conn.refresh_schema", "Refresh Schema")
                .accelerator("CmdOrCtrl+R")
                .build(app)?,
        )
        .build()?;

    let database_menu: Submenu<R> = SubmenuBuilder::new(app, "Database")
        .item(&MenuItemBuilder::with_id("db.new", "New Database…").build(app)?)
        .item(&MenuItemBuilder::with_id("db.rename", "Rename Database…").build(app)?)
        .item(&MenuItemBuilder::with_id("db.duplicate", "Duplicate Database…").build(app)?)
        .item(&MenuItemBuilder::with_id("db.drop", "Drop Database…").build(app)?)
        .separator()
        .item(&MenuItemBuilder::with_id("db.manage_roles", "Manage Roles & Grants…").build(app)?)
        .item(&MenuItemBuilder::with_id("db.activity", "Server Activity").build(app)?)
        .item(&MenuItemBuilder::with_id("db.copy_to", "Copy to Connection…").build(app)?)
        .build()?;

    let table_menu: Submenu<R> = SubmenuBuilder::new(app, "Table")
        .item(
            &MenuItemBuilder::with_id("table.new", "New Table…")
                .accelerator("CmdOrCtrl+Alt+N")
                .build(app)?,
        )
        .item(&MenuItemBuilder::with_id("table.rename", "Rename Table…").build(app)?)
        .item(&MenuItemBuilder::with_id("table.duplicate", "Duplicate Table…").build(app)?)
        .item(&MenuItemBuilder::with_id("table.move_schema", "Move to Schema…").build(app)?)
        .item(&MenuItemBuilder::with_id("table.drop", "Drop Table…").build(app)?)
        .separator()
        .item(&MenuItemBuilder::with_id("table.truncate", "Truncate Table…").build(app)?)
        .item(&MenuItemBuilder::with_id("table.vacuum", "VACUUM ANALYZE").build(app)?)
        .item(&MenuItemBuilder::with_id("table.reindex", "REINDEX").build(app)?)
        .separator()
        .item(&MenuItemBuilder::with_id("table.copy_create", "Copy CREATE Statement").build(app)?)
        .item(&MenuItemBuilder::with_id("table.copy_name", "Copy Qualified Name").build(app)?)
        .item(&MenuItemBuilder::with_id("table.copy_to", "Copy to Connection…").build(app)?)
        .build()?;

    let query_menu: Submenu<R> = SubmenuBuilder::new(app, "Query")
        .item(
            &MenuItemBuilder::with_id("query.run_current", "Run Current")
                .accelerator("CmdOrCtrl+Return")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("query.run_all", "Run All")
                .accelerator("CmdOrCtrl+Shift+Return")
                .build(app)?,
        )
        .item(
            &MenuItemBuilder::with_id("query.cancel", "Cancel Running Query")
                .accelerator("CmdOrCtrl+.")
                .build(app)?,
        )
        .separator()
        .item(
            &MenuItemBuilder::with_id("query.format", "Format / Beautify")
                .accelerator("CmdOrCtrl+I")
                .build(app)?,
        )
        .item(&MenuItemBuilder::with_id("query.explain", "EXPLAIN").build(app)?)
        .item(&MenuItemBuilder::with_id("query.explain_analyze", "EXPLAIN ANALYZE").build(app)?)
        .separator()
        .item(
            &MenuItemBuilder::with_id("query.toggle_comment", "Toggle Line Comment")
                .accelerator("CmdOrCtrl+/")
                .build(app)?,
        )
        .item(&MenuItemBuilder::with_id("query.toggle_limit", "Toggle Row Limit").build(app)?)
        .build()?;

    let window_menu: Submenu<R> = SubmenuBuilder::new(app, "Window")
        .minimize()
        .item(&PredefinedMenuItem::maximize(app, None)?)
        .separator()
        .item(&MenuItemBuilder::with_id("window.bring_to_front", "Bring All to Front").build(app)?)
        .build()?;

    let help_menu: Submenu<R> = SubmenuBuilder::new(app, "Help")
        .item(&MenuItemBuilder::with_id("help.docs", "Documentation").build(app)?)
        .item(&MenuItemBuilder::with_id("help.shortcuts", "Keyboard Shortcuts").build(app)?)
        .separator()
        .item(&MenuItemBuilder::with_id("help.check_updates", "Check for Updates…").build(app)?)
        .item(&MenuItemBuilder::with_id("help.report_issue", "Report an Issue…").build(app)?)
        .build()?;

    let menu = MenuBuilder::new(app)
        .items(&[
            &app_menu,
            &file_menu,
            &edit_menu,
            &view_menu,
            &connection_menu,
            &database_menu,
            &table_menu,
            &query_menu,
            &window_menu,
            &help_menu,
        ])
        .build()?;

    // Forward every menu click to the frontend as `menu:invoke <id>`.
    let handle = app.clone();
    app.on_menu_event(move |_app, ev| {
        let id = ev.id().0.clone();
        // Predefined items (cut/copy/paste/quit/…) and our App-menu items handled
        // natively are fine to forward too — the frontend can ignore unknown ids.
        if let Some(window) = handle.get_webview_window("main") {
            let _ = window.emit(MENU_EVENT, id);
        }
    });

    Ok(menu)
}
