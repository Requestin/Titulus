// engine/tests/stubs/include/internal/cef_ptr.h
#ifndef CEF_INCLUDE_INTERNAL_CEF_PTR_H_
#define CEF_INCLUDE_INTERNAL_CEF_PTR_H_

template <typename T>
class CefRefPtr {
  public:
    CefRefPtr() = default;
    CefRefPtr(T* p) : ptr_(p) {}
    T* get() const { return ptr_; }
    T* operator->() const { return ptr_; }
    explicit operator bool() const { return ptr_ != nullptr; }
    CefRefPtr& operator=(T* p) { ptr_ = p; return *this; }

  private:
    T* ptr_ = nullptr;
};

#endif
