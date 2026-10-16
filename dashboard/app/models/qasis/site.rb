module Qasis
  # A site under reports/: its QA runs, flow-discovery state and watch service.
  class Site
    LOG_LINES = 40

    attr_reader :slug, :service

    # Every site with reports or a service, so a just-watched site shows up too.
    def self.all(installation = Installation.new)
      services = Service.all.index_by(&:slug)
      dirs = Qasis.reports_dir.directory? ? Dir.children(Qasis.reports_dir).select { |n| Qasis.reports_dir.join(n).directory? } : []
      (dirs | services.keys).sort
        .map { |slug| new(slug, service: services[slug], installation:) }
        .select { |s| s.service || s.runs.any? || s.flows }
    end

    def self.find(slug, installation = Installation.new)
      all(installation).find { |s| s.slug == slug } or raise ActiveRecord::RecordNotFound, "No site #{slug}"
    end

    def initialize(slug, service:, installation:)
      @slug, @service, @installation = slug, service, installation
    end

    def to_param = slug
    def dir = Qasis.reports_dir.join(slug)
    def flows_dir = dir.join("flows")
    def url = service&.url || flows&.dig("origin") || "https://#{slug}"

    def runs = @runs ||= dir.directory? ? QaRun.for_site(self) : []
    def latest_run = runs.first

    def flows
      return @flows if defined?(@flows)
      @flows = Qasis.read_json(flows_dir.join("state.json"))
    end

    def flow_list = flows&.dig("flows")&.values || []
    def flow_passes = flows&.dig("runs") || []
    def last_pass_at = Qasis.time(flows&.dig("lastRunAt"))

    def flow_counts
      flow_list.group_by { |f| f["status"] }.transform_values(&:size)
    end

    # flows-cli holds flows/.lock for as long as it runs (store.mjs acquireLock),
    # in watch mode too, so the lock means "a discovery process is alive".
    def lock_held?
      Qasis.pid_alive?(File.read(flows_dir.join(".lock")).to_i)
    rescue Errno::ENOENT
      false
    end

    # A flow-discovery process that is not the watch service, e.g. `npm run flows`.
    def manual_run? = lock_held? && !service&.running?

    # The service logs a line when a pass starts, ends, fails or waits; the last one says where it is.
    PHASE = /\A(Qasis flow discovery:|Next pass at|Watching |✓ Docs|✗)/

    def last_phase = log_tail.reverse.find { |l| l.match?(PHASE) }&.strip

    def pass_running? = !!(service&.running? && lock_held? && last_phase&.start_with?("Qasis flow discovery:"))

    def interval_hours
      hours = service&.every_hours || @installation.flow_interval_hours
      hours == hours.to_i ? hours.to_i : hours
    end

    # flows-cli reschedules from state.lastRunAt; with no pass yet it runs on start.
    def next_pass_at
      return nil unless service&.running?
      last_pass_at ? last_pass_at + interval_hours.hours : Time.current
    end

    def overdue?
      next_pass_at.present? && !pass_running? && next_pass_at < 15.minutes.ago
    end

    def log_file = flows_dir.join("service.log")

    def log_tail
      @log_tail ||= begin
        File.open(log_file) do |f|
          f.seek([ f.size - 64.kilobytes, 0 ].max)
          f.read.force_encoding("UTF-8").scrub.lines.last(LOG_LINES)
        end
      rescue Errno::ENOENT
        []
      end
    end

    # Only while it is still the latest news: a later pass or restart clears it.
    def last_log_error = last_phase&.start_with?("✗") ? last_phase.delete_prefix("✗").strip : nil

    # :running, :stopped, :not_watched — the watch service, not a single pass.
    def watch_state
      return :not_watched unless service
      service.running? ? :running : :stopped
    end

    def problems
      list = []
      list << "Watch service is installed but not running (#{service.status[:state]})." if watch_state == :stopped
      list << "Flow pass is overdue: it was due #{next_pass_at.to_fs(:short)}." if overdue?
      list << "Service uses AI but no API key is available." if service&.ai? && !@installation.api_key_present?
      list << "Last error in the log: #{last_log_error}" if last_log_error && service
      list << "Latest QA run: #{latest_run.warning}" if latest_run&.warning
      list
    end
  end
end
