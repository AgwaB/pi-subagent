#include <errno.h>
#include <inttypes.h>
#include <libproc.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/proc_info.h>

#ifndef SZOMB
#define SZOMB 5
#endif

int main(int argc, char **argv) {
	if (argc != 2) {
		fprintf(stderr, "usage: darwin-process-identity <pid>\n");
		return 64;
	}
	char *end = NULL;
	errno = 0;
	long raw_pid = strtol(argv[1], &end, 10);
	if (errno != 0 || end == argv[1] || *end != '\0' || raw_pid <= 0 || raw_pid > INT32_MAX) {
		fprintf(stderr, "invalid pid\n");
		return 64;
	}
	const int pid = (int)raw_pid;
	struct proc_bsdinfo info = {0};
	const int bytes = proc_pidinfo(pid, PROC_PIDTBSDINFO, 1, &info, sizeof(info));
	if (bytes != (int)sizeof(info)) {
		const int proc_errno = errno;
		if (kill(pid, 0) != 0 && errno == ESRCH) return 3;
		fprintf(stderr, "proc_pidinfo failed for %d: errno=%d bytes=%d\n", pid, proc_errno, bytes);
		return 2;
	}
	if (info.pbi_status == SZOMB) return 3;
	if (info.pbi_pid != (uint32_t)pid || info.pbi_pgid == 0) {
		fprintf(stderr, "proc_pidinfo returned invalid identity for %d\n", pid);
		return 2;
	}
	printf("{\"pid\":%u,\"processGroupId\":%u,\"startSeconds\":\"%" PRIu64 "\",\"startMicroseconds\":\"%" PRIu64 "\"}\n",
		info.pbi_pid,
		info.pbi_pgid,
		info.pbi_start_tvsec,
		info.pbi_start_tvusec);
	return 0;
}
