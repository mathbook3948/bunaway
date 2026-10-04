cmake_minimum_required(VERSION 3.25)
project(bunaway_windows_host LANGUAGES CXX)
add_executable(bunaway-host host.cpp)
add_executable(windows-host-regressions ../../../tests/lifecycle/windows-host-native.cpp)
set_source_files_properties(../../../tests/lifecycle/windows-host-native.cpp PROPERTIES
    OBJECT_DEPENDS "${CMAKE_CURRENT_SOURCE_DIR}/host.cpp")
foreach(target bunaway-host windows-host-regressions)
    set_property(TARGET ${target} PROPERTY MSVC_RUNTIME_LIBRARY MultiThreaded)
    target_compile_features(${target} PRIVATE cxx_std_20)
    target_compile_definitions(${target} PRIVATE UNICODE _UNICODE WIN32_LEAN_AND_MEAN NOMINMAX)
    target_include_directories(${target} PRIVATE ../vendor vendor/webview2/include)
    target_compile_options(${target} PRIVATE /W4 /WX /utf-8 /EHsc)
    target_link_libraries(${target} PRIVATE
        bcrypt ole32 shell32 shlwapi version user32 gdi32 advapi32
        ${CMAKE_CURRENT_SOURCE_DIR}/vendor/webview2/lib/x64/WebView2LoaderStatic.lib
    )
endforeach()
