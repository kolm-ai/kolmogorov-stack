CC ?= cc
CFLAGS ?= -O2 -Wall -Wextra -std=c99
LDLIBS ?= -lcurl

PREFIX ?= /usr/local

all: kolm-cli

kolm-cli: kolm-cli.c kolm.h
	$(CC) $(CFLAGS) -DKOLM_IMPLEMENTATION -o $@ kolm-cli.c $(LDLIBS)

install: kolm.h kolm-cli
	install -d $(DESTDIR)$(PREFIX)/include
	install -m 644 kolm.h $(DESTDIR)$(PREFIX)/include/kolm.h
	install -d $(DESTDIR)$(PREFIX)/bin
	install -m 755 kolm-cli $(DESTDIR)$(PREFIX)/bin/kolm-cli

clean:
	rm -f kolm-cli kolm-cli.exe

.PHONY: all install clean
