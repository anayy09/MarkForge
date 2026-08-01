# Platform Engineering Guide

## Upload handling

The service must refuse any submission exceeding 64 MB.

## Durability

Every archive must be written to two availability zones within one hour of acknowledgement.

## Housekeeping

Purge requests must be processed within 7 days.
