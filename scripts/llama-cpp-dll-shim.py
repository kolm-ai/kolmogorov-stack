"""
W891 Phase 1.3 DLL shim — make llama-cpp-python loadable on Windows where the
cu125 wheel's ggml-cuda.dll needs cudart64_12.dll on the loader path.

torch ships cudart64_12.dll in <torch>/lib. On import, we add that directory to
the DLL search list before importing llama_cpp.

Usage:
    import scripts.llama_cpp_dll_shim  # noqa: F401
    import llama_cpp                   # now succeeds

Or call ensure_llama_cpp_loadable() explicitly.
"""
import os
import sys


def ensure_llama_cpp_loadable():
    if sys.platform != "win32":
        return
    try:
        import torch  # noqa: F401
    except ImportError:
        return
    import torch as _t
    lib_dir = os.path.join(os.path.dirname(_t.__file__), "lib")
    if os.path.isdir(lib_dir):
        try:
            os.add_dll_directory(lib_dir)
        except (OSError, AttributeError):
            pass
        os.environ["PATH"] = lib_dir + os.pathsep + os.environ.get("PATH", "")


ensure_llama_cpp_loadable()


if __name__ == "__main__":
    import llama_cpp
    print(f"llama_cpp {llama_cpp.__version__} OK")
