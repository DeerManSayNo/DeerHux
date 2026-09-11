fn main() {
    // The packaged UI runs on a loopback HTTP origin, so custom commands need
    // explicit ACL entries just like plugin commands.
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(
            tauri_build::AppManifest::new().commands(&[
                "sync_header_controls",
                "read_clipboard_file_paths",
                "hide_quick_session_window",
                "mark_quick_session_ready",
                "resize_quick_session_window",
            ]),
        ),
    )
    .expect("failed to build Tauri command permissions");
}
