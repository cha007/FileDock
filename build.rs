fn main() {
    // Rebuild when the frontend or the bundled demo changes (rust-embed inlines
    // them at compile time, so `tauri dev` needs this to pick edits up).
    println!("cargo:rerun-if-changed=public");
    println!("cargo:rerun-if-changed=demo");
    tauri_build::build()
}
