fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|a| a == "--version") {
        println!("scrybe-relay {}", scrybe_relay::VERSION);
        return;
    }
    scrybe_relay::run(scrybe_relay::start_cmd_from_args(&args))
}
