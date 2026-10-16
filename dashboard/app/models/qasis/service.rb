module Qasis
  # A background flow-discovery service installed by `npm run watch`
  # (setup/service.mjs): a launchd LaunchAgent on macOS, a systemd user unit on Linux.
  class Service
    attr_reader :url, :file, :manager, :argv

    def self.all
      if RUBY_PLATFORM.include?("darwin")
        Dir.glob(File.join(Dir.home, "Library", "LaunchAgents", "com.qasis.flows.*.plist")).filter_map { |f| from_launchd(f) }
      else
        base = ENV["XDG_CONFIG_HOME"].presence || File.join(Dir.home, ".config")
        Dir.glob(File.join(base, "systemd", "user", "qasis-flows-*.service")).filter_map { |f| from_systemd(f) }
      end
    end

    def self.site_url(file)
      File.read(file)[/qasis-site: (\S+)/, 1]
    end

    def self.from_launchd(file)
      url = site_url(file) or return nil
      json, ok = Qasis.run("plutil", "-convert", "json", "-o", "-", file)
      argv = ok ? JSON.parse(json)["ProgramArguments"] || [] : []
      new(url:, file:, manager: :launchd, argv:)
    rescue JSON::ParserError
      new(url:, file:, manager: :launchd, argv: [])
    end

    def self.from_systemd(file)
      url = site_url(file) or return nil
      exec = File.read(file)[/^ExecStart=(.*)$/, 1].to_s
      argv = exec.scan(/"((?:[^"\\]|\\.)*)"/).flatten.map { |w| w.gsub(/\\(.)/, '\1').gsub("$$", "$").gsub("%%", "%") }
      new(url:, file:, manager: :systemd, argv:)
    end

    def initialize(url:, file:, manager:, argv:)
      @url, @file, @manager, @argv = url, file, manager, argv
    end

    def slug = Qasis.site_slug(url)
    def label = File.basename(file, ".*")
    def manager_label = manager == :launchd ? "launchd" : "systemd --user"

    def option(name)
      i = argv.index("--#{name}")
      argv[i + 1] if i
    end

    def every_hours = option("every")&.to_f
    def ai? = !argv.include?("--no-ai")

    # { state:, pid:, last_exit:, running: }
    def status
      @status ||= manager == :launchd ? launchd_status : systemd_status
    end

    def running? = status[:running]
    def loaded? = status[:state] != "not loaded"

    private

    def launchd_status
      out, ok = Qasis.run("launchctl", "print", "gui/#{Process.uid}/#{label}")
      return { state: "not loaded", running: false } unless ok
      pid = out[/^\s*pid = (\d+)$/, 1]&.to_i
      { state: out[/^\s*state = (.+)$/, 1] || "unknown", pid:,
        last_exit: out[/^\s*last exit code = (.+)$/, 1], running: pid.present? && Qasis.pid_alive?(pid) }
    end

    def systemd_status
      out, ok = Qasis.run("systemctl", "--user", "show", File.basename(file), "-p", "ActiveState,SubState,MainPID,ExecMainStatus")
      prop = ->(k) { out[/^#{k}=(.*)$/, 1] }
      return { state: "unknown", running: false } unless ok && prop.("ActiveState")
      pid = prop.("MainPID").to_i
      { state: "#{prop.('ActiveState')}/#{prop.('SubState')}", pid: pid.positive? ? pid : nil,
        last_exit: prop.("ExecMainStatus"), running: prop.("ActiveState") == "active" }
    end
  end
end
