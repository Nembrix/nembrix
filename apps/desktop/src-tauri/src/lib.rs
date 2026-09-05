mod commands;
mod menu;
mod state;

use crate::state::AppState;
use secrets::Store;
#[cfg(debug_assertions)]
use specta_typescript::{BigIntExportBehavior, Typescript};
use tauri::Manager;
use tauri_specta::{collect_commands, Builder};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,nembrix=debug".into()),
        )
        .init();

    let builder = Builder::<tauri::Wry>::new().commands(collect_commands![
        commands::connections::list_connections,
        commands::connections::save_connection,
        commands::connections::delete_connection,
        commands::connections::connect,
        commands::connections::disconnect,
        commands::connections::test_connection,
        commands::connections::trust_ssh_host,
        commands::query::execute,
        commands::query::stream,
        commands::query::cancel,
        commands::query::format_sql,
        commands::query::run_script,
        commands::query::cancel_script,
        commands::schema::introspect,
        commands::menu_state::update_menu_state,
        commands::history::query_history,
        commands::history::list_saved_queries,
        commands::history::save_query,
        commands::history::delete_saved_query,
        commands::object_ops::preview_rename_database,
        commands::object_ops::preview_duplicate_database,
        commands::object_ops::preview_drop_database,
        commands::object_ops::apply_database_op,
        commands::object_ops::preview_rename_schema,
        commands::object_ops::preview_rename_table,
        commands::object_ops::preview_move_table,
        commands::object_ops::preview_duplicate_table,
        commands::object_ops::preview_drop_table,
        commands::object_ops::apply_object_op,
    ]);

    #[cfg(debug_assertions)]
    builder
        .export(
            // i64/u64 appear in the type graph (CellValue::Int, ExecSummary's
            // rows_affected/elapsed_ms). specta's default is BigInt-Fail, which
            // panics the whole app at startup ("BigIntForbidden"); export them
            // as TS `number` — the frontend already treats these fields as
            // numbers and Postgres row counts stay well within f64 range.
            Typescript::default().bigint(BigIntExportBehavior::Number),
            "../bindings/commands.ts",
        )
        .expect("specta export");

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(move |app| {
            let app_handle = app.handle().clone();
            let data_dir = app_handle.path().app_data_dir().expect("app data dir");
            let store = Store::open(&data_dir.join("metadata.db")).expect("metadata store");
            app.manage(AppState::new(store));

            // Install the native menu bar and wire its events into the webview.
            let m = menu::build(&app_handle)?;
            app.set_menu(m)?;

            builder.mount_events(app);

            // The main window is created hidden (`visible: false`) so the
            // frontend can reveal it only after its first paint — no "empty
            // shell pops into the populated app" blink. The frontend calls
            // `getCurrentWindow().show()` once mounted. This is a SAFETY NET:
            // if the webview never loads (JS crash, blank bundle), show the
            // window anyway after a short delay so a broken frontend can't
            // leave an invisible, un-closable window.

            // Set when the user closes the window, so the startup safety net
            // below can tell "the frontend never came up" from "the user shut
            // this on purpose" — both look like a hidden window otherwise.
            //
            // Only macOS hides on close (other platforms exit), so elsewhere
            // this stays false and the net behaves exactly as before. The
            // allow keeps non-macOS builds warning-free, since nothing writes
            // to it there.
            #[cfg_attr(not(target_os = "macos"), allow(unused_variables))]
            let user_closed = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));

            // macOS: the red close button destroys the window by default,
            // which leaves the process running with nothing to click and no
            // window for Reopen to restore — the app looks shut but only Quit
            // actually exits. Hide instead, matching platform convention, so
            // the dock icon brings it back.
            #[cfg(target_os = "macos")]
            if let Some(win) = app_handle.get_webview_window("main") {
                let handle = win.clone();
                let closed = user_closed.clone();
                win.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        closed.store(true, std::sync::atomic::Ordering::Relaxed);
                        let _ = handle.hide();
                    }
                });
            }

            if let Some(win) = app_handle.get_webview_window("main") {
                // Skipped once the user has closed the window. Without that
                // check this net fights the close handler above: closing
                // within the first 3s reads as "never shown", and the timer
                // pops the window straight back up.
                let closed = user_closed.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(3000));
                    if closed.load(std::sync::atomic::Ordering::Relaxed) {
                        return;
                    }
                    if let Ok(false) = win.is_visible() {
                        let _ = win.show();
                    }
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::connections::list_connections,
            commands::connections::save_connection,
            commands::connections::delete_connection,
            commands::connections::connect,
            commands::connections::disconnect,
            commands::connections::test_connection,
            commands::connections::trust_ssh_host,
            commands::query::execute,
            commands::query::stream,
            commands::query::cancel,
            commands::query::format_sql,
            commands::query::run_script,
            commands::query::cancel_script,
            commands::schema::introspect,
            commands::object_ops::preview_rename_database,
            commands::object_ops::preview_duplicate_database,
            commands::object_ops::preview_drop_database,
            commands::object_ops::apply_database_op,
            commands::object_ops::preview_rename_schema,
            commands::object_ops::preview_rename_table,
            commands::object_ops::preview_move_table,
            commands::object_ops::preview_duplicate_table,
            commands::object_ops::preview_drop_table,
            commands::object_ops::apply_object_op,
            commands::history::query_history,
            commands::history::list_saved_queries,
            commands::history::save_query,
            commands::history::delete_saved_query,
        ])
        .build(tauri::generate_context!())
        .expect("error building app")
        .run(|app, event| {
            // macOS: the red close button destroys the window but leaves the
            // process alive, and without a Reopen handler clicking the dock
            // icon does nothing — the app looks shut but Quit is the only way
            // out. Recreate (or re-show) the main window instead.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = event {
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.show();
                    let _ = win.set_focus();
                }
            }
            let _ = (app, event);
        });
}
