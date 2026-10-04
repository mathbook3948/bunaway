cmake_minimum_required(VERSION 3.25)
project(bunaway_windows_host LANGUAGES CXX)
add_executable(bunaway-host host.cpp)
set_property(TARGET bunaway-host PROPERTY MSVC_RUNTIME_LIBRARY MultiThreaded)
target_compile_features(bunaway-host PRIVATE cxx_std_20)
target_compile_definitions(bunaway-host PRIVATE UNICODE _UNICODE WIN32_LEAN_AND_MEAN NOMINMAX)
target_include_directories(bunaway-host PRIVATE ../vendor vendor/webview2/include)
target_compile_options(bunaway-host PRIVATE /W4 /WX /utf-8 /EHsc)
target_link_libraries(bunaway-host PRIVATE
    bcrypt ole32 shell32 shlwapi version user32 gdi32 advapi32
    ${CMAKE_CURRENT_SOURCE_DIR}/vendor/webview2/lib/x64/WebView2LoaderStatic.lib
)
