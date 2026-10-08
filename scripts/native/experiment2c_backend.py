"""Temporary native experiment host: existing backend, display inference off.

No CARLA physics/control code is replaced. The normal host is restored afterward.
"""
from unittest.mock import patch
from backend.server import main

if __name__ == '__main__':
    with patch('backend.perception.PerceptionService', return_value=None):
        main()
