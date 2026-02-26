use std::path::PathBuf;

use chrono::{DateTime, NaiveDate, Utc};

use agentmonitor_rs::config::Config;
use agentmonitor_rs::db;
use agentmonitor_rs::importer::{ImportOptions, ImportSource, run_import};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match parse_cli(&args) {
        Ok(mut options) => {
            let config = Config::from_env();
            let conn = match db::initialize(&config.db_path) {
                Ok(conn) => conn,
                Err(err) => {
                    eprintln!("failed to initialize DB: {err}");
                    std::process::exit(1);
                }
            };

            options.max_payload_kb = config.max_payload_kb;
            let result = run_import(&conn, &options);

            println!("Import complete.");
            println!("  Files processed:   {}", result.total_files);
            println!("  Files skipped:     {}", result.skipped_files);
            println!("  Events found:      {}", result.total_events_found);
            println!("  Events imported:   {}", result.total_events_imported);
            println!("  Duplicates skipped: {}", result.total_duplicates);
        }
        Err(err) => {
            eprintln!("{err}");
            print_usage();
            std::process::exit(1);
        }
    }
}

fn parse_cli(args: &[String]) -> Result<ImportOptions, String> {
    let mut source = ImportSource::All;
    let mut from: Option<DateTime<Utc>> = None;
    let mut to: Option<DateTime<Utc>> = None;
    let mut dry_run = false;
    let mut force = false;
    let mut claude_dir: Option<PathBuf> = None;
    let mut codex_dir: Option<PathBuf> = None;

    let mut i = 0usize;
    while i < args.len() {
        match args[i].as_str() {
            "--help" | "-h" => {
                print_usage();
                std::process::exit(0);
            }
            "--source" => {
                let value = args.get(i + 1).ok_or("--source requires a value")?;
                source = match value.as_str() {
                    "claude-code" => ImportSource::ClaudeCode,
                    "codex" => ImportSource::Codex,
                    "all" => ImportSource::All,
                    _ => return Err(format!("unsupported --source value: {value}")),
                };
                i += 1;
            }
            "--from" => {
                let value = args.get(i + 1).ok_or("--from requires an ISO timestamp")?;
                from = Some(parse_timestamp(value)?);
                i += 1;
            }
            "--to" => {
                let value = args.get(i + 1).ok_or("--to requires an ISO timestamp")?;
                to = Some(parse_timestamp(value)?);
                i += 1;
            }
            "--dry-run" => dry_run = true,
            "--force" => force = true,
            "--claude-dir" => {
                let value = args.get(i + 1).ok_or("--claude-dir requires a path")?;
                claude_dir = Some(PathBuf::from(value));
                i += 1;
            }
            "--codex-dir" => {
                let value = args.get(i + 1).ok_or("--codex-dir requires a path")?;
                codex_dir = Some(PathBuf::from(value));
                i += 1;
            }
            unknown => return Err(format!("unknown argument: {unknown}")),
        }
        i += 1;
    }

    Ok(ImportOptions {
        source,
        from,
        to,
        dry_run,
        force,
        claude_dir,
        codex_dir,
        max_payload_kb: 10,
    })
}

fn parse_timestamp(value: &str) -> Result<DateTime<Utc>, String> {
    if let Ok(dt) = DateTime::parse_from_rfc3339(value) {
        return Ok(dt.with_timezone(&Utc));
    }
    if let Ok(date) = NaiveDate::parse_from_str(value, "%Y-%m-%d")
        && let Some(naive_dt) = date.and_hms_opt(0, 0, 0)
    {
        return Ok(DateTime::from_naive_utc_and_offset(naive_dt, Utc));
    }
    Err(format!("invalid ISO timestamp/date: {value}"))
}

fn print_usage() {
    println!("Usage: cargo run --manifest-path rust-backend/Cargo.toml --bin import -- [options]");
    println!();
    println!("Options:");
    println!("  --source <claude-code|codex|all>   Import source (default: all)");
    println!("  --from <ISO timestamp>              Import events after this time");
    println!("  --to <ISO timestamp>                Import events before this time");
    println!("  --dry-run                           Parse only, do not write DB");
    println!("  --force                             Re-import files even if unchanged");
    println!("  --claude-dir <path>                 Override Claude logs root");
    println!("  --codex-dir <path>                  Override Codex home root");
    println!("  --help                              Show this help");
}
