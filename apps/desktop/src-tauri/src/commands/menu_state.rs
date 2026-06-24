//! Sync the native menu's enabled/disabled state from the frontend.
//!
//! The frontend owns the availability rules (so they're shared with the
//! browser-mode fallback menu and the palette). When store state changes,
//! it calls `update_menu_state(disabled_ids)` and we walk the menu, calling
//! `set_enabled(false)` on every matching item, and `set_enabled(true)` on
//! every item we own that isn't in the list.
//!
//! Items we don't have rules for (Help → Documentation, App → Preferences,
//! etc.) are left at their default enabled state.

use std::collections::HashSet;
use tauri::menu::MenuItemKind;
use tauri::{AppHandle, Runtime, Wry};

#[tauri::command]
#[specta::specta]
pub fn update_menu_state(
    app: AppHandle<Wry>,
    disabled_ids: Vec<String>,
) -> Result<(), String> {
    let menu = app.menu().ok_or("no menu installed")?;
    let disabled: HashSet<String> = disabled_ids.into_iter().collect();
    walk_and_apply(&menu.items().map_err(|e| e.to_string())?, &disabled)?;
    Ok(())
}

fn walk_and_apply<R: Runtime>(
    items: &[MenuItemKind<R>],
    disabled: &HashSet<String>,
) -> Result<(), String> {
    for item in items {
        match item {
            MenuItemKind::MenuItem(mi) => {
                let id = mi.id().0.clone();
                // Only flip items that look like ours (custom ids use dots,
                // predefined items use their auto-generated ids).
                if id.contains('.') {
                    let _ = mi.set_enabled(!disabled.contains(&id));
                }
            }
            MenuItemKind::Submenu(sm) => {
                if let Ok(children) = sm.items() {
                    walk_and_apply(&children, disabled)?;
                }
            }
            _ => {}
        }
    }
    Ok(())
}
