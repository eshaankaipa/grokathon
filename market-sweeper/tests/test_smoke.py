import importlib


def test_classifier_package_importable():
    assert importlib.import_module("classifier") is not None
