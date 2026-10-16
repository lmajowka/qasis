module Qasis
  # One QA run: reports/<site>/<YYYY-MM-DD>[-N]/. Reads raw/report.json
  # ({ run, meta, report }), falling back to raw/llm-report.json.
  class QaRun
    DIR = /\A\d{4}-\d{2}-\d{2}(-\d+)?\z/

    attr_reader :site, :name, :dir

    def self.for_site(site)
      Dir.children(site.dir)
        .select { |n| n.match?(DIR) && File.directory?(site.dir.join(n)) }
        .map { |n| new(site, n) }
        .select(&:report)
        .sort_by(&:order).reverse
    end

    def initialize(site, name)
      @site, @name, @dir = site, name, site.dir.join(name)
    end

    # "2026-10-16-2" sorts after "2026-10-16".
    def order
      date, n = name.split("-", 4).then { |p| [ p[0, 3].join("-"), p[3] ] }
      "#{date}-#{(n || 1).to_s.rjust(4, '0')}"
    end

    def saved
      @saved ||= Qasis.read_json(dir.join("raw", "report.json")) || Qasis.read_json(dir.join("raw", "llm-report.json")) || {}
    end

    def report = saved["report"]
    def meta = saved["meta"] || {}
    def health = report&.dig("overallHealth")
    def summary = report&.dig("summary")
    def issues = report&.dig("issues") || []
    def positives = report&.dig("positives") || []
    def finished_at = Qasis.time(saved.dig("run", "finishedAt"))
    def pages = saved.dig("run", "pagesVisited")
    def written_by = meta["provider"] ? meta["model"] : "basic rules"
    def warning = meta["warning"]

    def counts
      @counts ||= SEVERITIES.index_with { |s| issues.count { |i| i["severity"] == s } }
    end

    def html? = dir.join("report.html").file?
    def md? = dir.join("report.md").file?
  end
end
