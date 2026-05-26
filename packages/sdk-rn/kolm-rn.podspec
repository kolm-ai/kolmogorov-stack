Pod::Spec.new do |s|
  s.name         = "kolm-rn"
  s.version      = "0.2.6"
  s.summary      = "React Native bridge for signed .kolm artifacts."
  s.description  = "Loads, verifies, and dispatches .kolm artifacts through the native Kolm SDKs."
  s.homepage     = "https://kolm.ai"
  s.license      = { :type => "Apache-2.0" }
  s.author       = { "Kolm" => "security@kolm.ai" }
  s.source       = { :git => "https://github.com/kolm-ai/kolm-stack.git", :tag => "v#{s.version}" }
  s.platforms    = { :ios => "14.0" }
  s.source_files = "ios/**/*.{h,m,mm,swift}"
  s.dependency "React-Core"
  s.swift_version = "5.9"
end
