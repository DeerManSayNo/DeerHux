//! macOS menu-bar integration for the DeerHux 灵动岛 (dynamic island) overlay.
//!
//! Ported from AIControls' `live_island_macos.rs` (unmodified source, copied for
//! DeerHux's own use). All functions call AppKit APIs and must run on the main thread.

use objc2::msg_send;
use objc2::MainThreadMarker;
use objc2_app_kit::{NSMainMenuWindowLevel, NSScreen, NSWindow, NSWindowLevel, NSWindowStyleMask};
use tauri::{Runtime, WebviewWindow};

/// Extra horizontal padding so content stays clear of the camera housing.
const NOTCH_SAFETY_PADDING: f64 = 12.0;
/// Used when macOS does not report auxiliary top areas (typical MacBook Air / Pro notch).
const FALLBACK_NOTCH_EXCLUSION_WIDTH: f64 = 224.0;

#[derive(Debug, Clone, Copy)]
pub struct NotchLayout {
    pub has_notch: bool,
    /// Logical pixels — matches the webview coordinate space for CSS.
    pub notch_width: f64,
}

impl Default for NotchLayout {
    fn default() -> Self {
        Self {
            has_notch: false,
            notch_width: 0.0,
        }
    }
}

pub fn configure_live_island_window<R: Runtime>(window: &WebviewWindow<R>) {
    let Ok(ns_ptr) = window.ns_window() else {
        return;
    };

    let ns_window: &NSWindow = unsafe { &*ns_ptr.cast() };
    let level: NSWindowLevel = NSMainMenuWindowLevel + 3;
    ns_window.setLevel(level);

    // Receive clicks without requiring a prior focus click (menu-bar overlay).
    let mask = ns_window.styleMask();
    ns_window.setStyleMask(mask | NSWindowStyleMask::NonactivatingPanel);
    ns_window.setAcceptsMouseMovedEvents(true);

    let _: () = unsafe { msg_send![ns_window, _setPreventsActivation: true] };
}

/// Whether the island window should be excluded from screen-share capture.
///
/// DeerHux always reports `false`: the island is a normal on-screen overlay.
pub fn query_notch_layout() -> NotchLayout {
    let Some(mtm) = MainThreadMarker::new() else {
        return NotchLayout::default();
    };

    let Some(screen) = NSScreen::mainScreen(mtm) else {
        return NotchLayout::default();
    };

    let top_inset = screen.safeAreaInsets().top;
    if top_inset <= 0.0 {
        return NotchLayout::default();
    }

    let frame_width = screen.frame().size.width;
    let left_width = screen.auxiliaryTopLeftArea().size.width;
    let right_width = screen.auxiliaryTopRightArea().size.width;

    let base_width = if left_width > 0.0 && right_width > 0.0 {
        (frame_width - left_width - right_width).max(0.0)
    } else {
        FALLBACK_NOTCH_EXCLUSION_WIDTH
    };

    let notch_width = base_width + NOTCH_SAFETY_PADDING * 2.0;
    NotchLayout {
        has_notch: true,
        notch_width,
    }
}
