mod commands;
mod menu;
mod state;

use crate::state::AppState;
use secrets::Store;
use specta_typescript::Typescript;
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
        .export(Typescript::default(), "../bindings/commands.ts")
        .expect("specta export");

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_os::init())
        .setup(move |app| {
            let app_handle = app.handle().clone();
            let data_dir = app_handle.path().app_data_dir().expect("app data dir");
            let store = Store::open(&data_dir.join("metadata.db")).expect("metadata store");
            app.manage(AppState::new(store));

            // Install the native menu bar and wire its events into the webview.
            let m = menu::build(&app_handle)?;
            app.set_menu(m)?;

            builder.mount_events(app);
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
        .run(tauri::generate_context!())
        .expect("error running app");
}
