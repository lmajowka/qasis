class SitesController < ApplicationController
  def show
    @installation = Qasis::Installation.new
    @site = Qasis::Site.find(params[:id], @installation)
  end
end
