Rails.application.routes.draw do
  get "up" => "rails/health#show", as: :rails_health_check

  root "dashboard#index"
  resources :sites, only: :show, constraints: { id: /[^\/]+/ }
  # Files the runner wrote under reports/ (HTML reports, screenshots, flow docs).
  get "files/*path" => "report_files#show", as: :report_file, format: false
end
