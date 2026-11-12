import pathlib,json,time,os
p=pathlib.Path('/sys/fs/cgroup')
def fields(path):
 return {k:int(v) for k,v in (line.split() for line in path.read_text().splitlines())}
while True:
 try:
  processes=[]
  for entry in pathlib.Path('/proc').iterdir():
   if not entry.name.isdigit():continue
   try:
    cmd=(entry/'comm').read_text().strip()
    if cmd not in ['cliproxy-home','cliproxy-node','python3']:continue
    status=dict(line.split(':',1) for line in (entry/'status').read_text().splitlines())
    processes.append({'pid':int(entry.name),'comm':cmd,'rssBytes':int(status.get('VmRSS','0 kB').split()[0])*1024,'fds':len(list((entry/'fd').iterdir()))})
   except (FileNotFoundError,ProcessLookupError):pass
  network={}
  for line in pathlib.Path('/proc/net/dev').read_text().splitlines()[2:]:
   name,counts=line.split(':');values=counts.split();network[name.strip()]={'rxBytes':int(values[0]),'txBytes':int(values[8])}
  tcp=[]
  for name in ['tcp','tcp6']:
   for line in pathlib.Path('/proc/net/'+name).read_text().splitlines()[1:]:
    columns=line.split();tx,rx=columns[4].split(':');tcp.append({'state':columns[3],'txQueuedBytes':int(tx,16),'rxQueuedBytes':int(rx,16)})
  print(json.dumps({'at':time.time()*1000,'monotonic':time.monotonic(),'cpu':fields(p/'cpu.stat'),'cpuMax':(p/'cpu.max').read_text().strip(),'memoryCurrent':int((p/'memory.current').read_text()),'memoryPeak':int((p/'memory.peak').read_text()),'memoryMax':(p/'memory.max').read_text().strip(),'swapMax':(p/'memory.swap.max').read_text().strip(),'memoryStat':fields(p/'memory.stat'),'memoryEvents':fields(p/'memory.events'),'processes':processes,'network':network,'tcp':{'sockets':len(tcp),'txQueuedBytes':sum(x['txQueuedBytes'] for x in tcp),'rxQueuedBytes':sum(x['rxQueuedBytes'] for x in tcp)}}),flush=True)
 except Exception as error:print(json.dumps({'at':time.time()*1000,'error':type(error).__name__}),flush=True)
 time.sleep(1)
