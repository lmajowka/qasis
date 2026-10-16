module ApplicationHelper
  HEALTH_LABEL = { "good" => "Good", "fair" => "Fair", "poor" => "Poor" }.freeze
  FLOW_STATUS = { "new" => "New", "changed" => "Changed", "active" => "Active", "missing" => "Not seen" }.freeze

  def health_badge(health)
    return tag.span("No QA run", class: "badge none") unless health
    tag.span(HEALTH_LABEL.fetch(health, health), class: "badge #{health}")
  end

  def status_dot(state, text)
    tag.span(class: "status #{state}") { tag.span(class: "dot") + text }
  end

  def watch_badge(site)
    case site.watch_state
    when :running
      site.pass_running? ? status_dot(:busy, "Pass running") : status_dot(:ok, "Watching")
    when :stopped then status_dot(:bad, "Stopped")
    else site.manual_run? ? status_dot(:busy, "Manual run") : status_dot(:off, "Not watched")
    end
  end

  def check_row(label, ok, detail = nil)
    tag.li(class: ok ? "ok" : "bad") do
      tag.span(ok ? "✓" : "✗", class: "mark") + tag.span(label, class: "label") + (detail ? tag.span(detail, class: "detail") : "".html_safe)
    end
  end

  def at(time)
    return "—" unless time
    tag.time(time.future? ? "in #{time_ago_in_words(time)}" : "#{time_ago_in_words(time)} ago",
      datetime: time.iso8601, title: time.localtime.to_fs(:long))
  end

  def severity_cells(counts)
    safe_join(Qasis::SEVERITIES.map { |s| tag.td(counts ? counts[s] : "—", class: [ "num", (s if counts&.dig(s).to_i.positive?) ]) })
  end

  def report_link(*parts, label:)
    link_to label, report_file_path(path: parts.join("/")), target: "_blank", rel: "noopener"
  end

  def flow_chip(status)
    tag.span(FLOW_STATUS.fetch(status, status), class: "chip #{status}")
  end
end
