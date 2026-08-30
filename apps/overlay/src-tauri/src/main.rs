// Release builds run as a GUI app so launching the overlay does not also open a
// console window; debug builds keep the console for the `eprintln!` diagnostics.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    agent_lantern_overlay_lib::run();
}
