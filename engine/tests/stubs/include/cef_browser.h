// engine/tests/stubs/include/cef_browser.h
// Minimal stub so LivePipeline unit tests compile without the CEF SDK.

#ifndef CEF_INCLUDE_CEF_BROWSER_H_
#define CEF_INCLUDE_CEF_BROWSER_H_

#include "include/internal/cef_ptr.h"

#include <string>

class CefFrame {
  public:
    void ExecuteJavaScript(const std::string&, const std::string&, int) {}
    std::string GetURL() { return {}; }
};

class CefBrowser {
  public:
    CefRefPtr<CefFrame> GetMainFrame() { return nullptr; }
};

#endif
