# Serves files from reports/ so the dashboard can link to reports and flow docs.
class ReportFilesController < ApplicationController
  TEXT = %w[.md .log .json].freeze

  def show
    root = Qasis.reports_dir.realpath
    path = root.join(params[:path]).realpath
    raise ActionController::RoutingError, "Not found" unless path.file? && path.to_s.start_with?("#{root}/")

    type = TEXT.include?(path.extname) ? "text/plain; charset=utf-8" : nil
    send_file path, disposition: :inline, type: type || Marcel::MimeType.for(path, name: path.basename.to_s)
  rescue Errno::ENOENT
    raise ActionController::RoutingError, "Not found"
  end
end
