class DashboardController < ApplicationController
  def index
    @installation = Qasis::Installation.new
    @sites = Qasis::Site.all(@installation)
  end
end
