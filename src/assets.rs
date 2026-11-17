use rust_embed::RustEmbed;
use std::fs;
use std::path::{Component, Path};

#[derive(RustEmbed)]
#[folder = "public"]
pub struct PublicAssets;

#[derive(RustEmbed)]
#[folder = "demo"]
pub struct DemoAssets;

/// Unpack the bundled sample project the first time the app runs. Files that
/// already exist are left untouched so the user's edits survive upgrades.
pub fn ensure_demo(dest: &Path) {
    for name in DemoAssets::iter() {
        let relative = Path::new(name.as_ref());
        let safe = relative
            .components()
            .all(|part| matches!(part, Component::Normal(_)));
        if !safe {
            continue;
        }
        let target = dest.join(relative);
        if target.exists() {
            continue;
        }
        let Some(file) = DemoAssets::get(name.as_ref()) else {
            continue;
        };
        if let Some(parent) = target.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let _ = fs::write(&target, file.data.as_ref());
    }
}
