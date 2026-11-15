# Test destination: FTPS on 21, plain FTP on 2121, SFTP on 22.
vsftpd /vsftpd-tls.conf &
vsftpd /vsftpd-plain.conf &
exec /usr/sbin/sshd -D -e
