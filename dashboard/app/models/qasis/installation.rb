module Qasis
  # Is Qasis set up on this machine: config, API key, and the QA runner.
  class Installation
    def config_file = Qasis.config_dir.join("config.json")
    def config = @config ||= Qasis.read_json(config_file)
    def configured? = config.present?

    def provider = config&.dig("provider")
    def provider_label = PROVIDERS.dig(provider, :label) || provider
    def model = config&.dig("model").presence || PROVIDERS.dig(provider, :default_model)
    def credential_store = config&.dig("credentialStore")
    def installed_at = Qasis.time(config&.dig("installedAt"))

    def flow_interval_hours
      hours = config&.dig("flowDiscovery", "intervalHours")
      hours.is_a?(Numeric) && hours.positive? ? hours : DEFAULT_FLOW_INTERVAL_HOURS
    end

    def credential_store_label
      { "macos-keychain" => "macOS Keychain",
        "secret-service" => "Secret Service",
        "file" => "File (#{Qasis.config_dir.join('credentials.json')})" }[credential_store] || credential_store
    end

    # Checks that a key exists without reading it where that is possible.
    def api_key_present?
      return @api_key_present if defined?(@api_key_present)
      account = "llm-api-key:#{provider}"
      @api_key_present =
        case credential_store
        when "macos-keychain"
          # Without -w, `security` prints only the item's attributes, not the password.
          Qasis.run("security", "find-generic-password", "-s", "qasis", "-a", account).last
        when "secret-service"
          out, ok = Qasis.run("secret-tool", "lookup", "service", "qasis", "account", account)
          ok && out.present?
        when "file"
          Qasis.read_json(Qasis.config_dir.join("credentials.json"))&.key?(provider) || false
        else
          false
        end
    end

    def node_modules? = Qasis.root.join("node_modules", "playwright").directory?

    def chromium?
      cache = ENV["PLAYWRIGHT_BROWSERS_PATH"].presence ||
        (RUBY_PLATFORM.include?("darwin") ? File.join(Dir.home, "Library", "Caches", "ms-playwright") : File.join(Dir.home, ".cache", "ms-playwright"))
      Dir.glob(File.join(cache, "chromium*")).any?
    end

    def runner_ready? = node_modules? && chromium?

    def problems
      list = []
      list << "Qasis is not configured. Run: bash qasis.sh" unless configured?
      list << "No #{provider_label} API key in #{credential_store_label}. Re-run: bash qasis.sh" if configured? && !api_key_present?
      list << "Node packages are not installed. Run: npm install" unless node_modules?
      list << "Chromium is not installed. Run: npx playwright install chromium" unless chromium?
      list
    end
  end
end
