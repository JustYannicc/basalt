import asyncio, hashlib, json, os, resource, ssl, time, urllib.parse, uuid

origin=urllib.parse.urlsplit(os.environ['SCALE_ORIGIN'])
deadline=float(os.environ['SCALE_DEADLINE'])
seed=os.environ['SCALE_KEY_SEED']
admin=os.environ['SCALE_ADMIN']
context=ssl.create_default_context()
jobs={}
tasks={}
total={'requestBytes':0,'responseBytes':0,'requests':0,'peakActive':0,'active':0}

def percentile(values,p):
    values=sorted(x for x in values if x is not None)
    return values[min(len(values)-1,int((len(values)-1)*p))] if values else None

async def request_one(spec,index,records,scheduled):
    started=time.monotonic();user=index%spec['users']
    key='scale-'+hashlib.sha256((seed+':'+str(user)).encode()).hexdigest()
    protocol=spec.get('protocol','chat');model={'chat':'scale-chat','responses':'scale-codex','messages':'scale-claude'}[protocol]
    path={'chat':'/v1/chat/completions','responses':'/v1/responses','messages':'/v1/messages'}[protocol]
    payload={'model':model,'stream':True,'metadata':{'scale_duration':str(spec.get('streamSeconds',60)),'scale_rate':str(spec.get('rate',50))}}
    text='x'*spec.get('bodyBytes',262144)
    if protocol=='responses': payload.update(input=text)
    else: payload.update(messages=[{'role':'user','content':text}],max_tokens=100000)
    body=json.dumps(payload,separators=(',',':')).encode()
    wire=(f'POST {path} HTTP/1.1\r\nHost: {origin.hostname}\r\nAuthorization: Bearer {key}\r\nContent-Type: application/json\r\nContent-Length: {len(body)}\r\nConnection: close\r\nX-Request-Id: {uuid.uuid4()}\r\n\r\n'.encode()+body)
    record={'index':index,'user':user,'scheduled':scheduled,'started':time.time(),'scheduleLagMs':max(0,(started-scheduled)*1000),'status':0,'bytes':0,'events':0,'terminal':False,'ttfbMs':None,'firstContentMs':None,'error':None}
    total['active']+=1;total['peakActive']=max(total['peakActive'],total['active']);writer=None
    try:
        reader,writer=await asyncio.wait_for(asyncio.open_connection(origin.hostname,origin.port or 443,ssl=context,server_hostname=origin.hostname,limit=32*1024*1024),20)
        writer.write(wire);await writer.drain();total['requestBytes']+=len(wire);total['requests']+=1
        head=await asyncio.wait_for(reader.readuntil(b'\r\n\r\n'),30)
        record['ttfbMs']=(time.monotonic()-started)*1000;record['status']=int(head.split(b' ',2)[1]);record['bytes']+=len(head)
        buffer=b''
        async def consume(data):
            nonlocal buffer
            record['bytes']+=len(data);buffer+=data
            while b'\n\n' in buffer:
                event,buffer=buffer.split(b'\n\n',1)
                if b'data:' not in event: continue
                record['events']+=1
                if record['firstContentMs'] is None and (b'"content"' in event or b'output_text.delta' in event or b'text_delta' in event): record['firstContentMs']=(time.monotonic()-started)*1000
                if b'[DONE]' in event or b'response.completed' in event or b'message_stop' in event:record['terminal']=True
        chunked=b'transfer-encoding: chunked' in head.lower()
        while True:
            if chunked:
                line=await asyncio.wait_for(reader.readline(),spec.get('streamSeconds',60)+40)
                if not line:break
                size=int(line.strip().split(b';')[0],16)
                if not size:break
                data=await reader.readexactly(size);await reader.readexactly(2)
            else:
                data=await asyncio.wait_for(reader.read(65536),spec.get('streamSeconds',60)+40)
                if not data:break
            await consume(data)
            if total['responseBytes']+record['bytes']>6_000_000_000:raise RuntimeError('byte_cap')
        if record['status']!=200:record['error']='http_'+str(record['status'])
        elif not record['terminal']:record['error']='truncated'
    except Exception as e:record['error']=type(e).__name__
    finally:
        record['durationMs']=(time.monotonic()-started)*1000
        total['responseBytes']+=record['bytes'];total['active']-=1;records.append(record)
        if writer:
            writer.close()
            try:await writer.wait_closed()
            except Exception:pass

async def run(spec):
    records=[];started=time.time();mono=time.monotonic();cpu=time.process_time()
    job=jobs[spec['id']];job.update(state='running',started=started)
    concurrency=spec['concurrency'];requests=spec.get('requests',concurrency)
    sem=asyncio.Semaphore(concurrency)
    async def one(index):
        scheduled=mono+index/spec.get('startsPerSecond',1e9)
        await asyncio.sleep(max(0,scheduled-time.monotonic()))
        async with sem:await request_one(spec,index,records,scheduled)
    await asyncio.gather(*(one(i) for i in range(requests)))
    elapsed=time.time()-started
    job.update(state='done',ended=time.time(),elapsedSeconds=elapsed,count=len(records),success=sum(r['status']==200 and r['terminal'] and r['error'] is None for r in records),errors={e:sum(r['error']==e for r in records) for e in set(r['error'] for r in records) if e},rpm=len(records)/elapsed*60,ttfbMs={p:percentile([r['ttfbMs'] for r in records],q) for p,q in [('p50',.5),('p95',.95),('p99',.99)]},firstContentMs={p:percentile([r['firstContentMs'] for r in records],q) for p,q in [('p50',.5),('p95',.95),('p99',.99)]},scheduleLagMsP99=percentile([r['scheduleLagMs'] for r in records],.99),responseBytes=sum(r['bytes'] for r in records),events=sum(r['events'] for r in records),cpuSeconds=time.process_time()-cpu,rssKb=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,records=records)

async def connection(reader,writer):
    try:
        head=await reader.readuntil(b'\r\n\r\n');method,path,_=head.split(b'\r\n',1)[0].decode().split(' ',2)
        h={a.lower():b.strip() for a,_,b in (x.partition(':') for x in head.decode().split('\r\n')[1:] if ':' in x)}
        body=await reader.readexactly(int(h.get('content-length','0')))
        status=200
        if path=='/health':result={'status':'ok','role':'generator'}
        elif h.get('x-scale-admin')!=admin:status=403;result={'error':'denied'}
        elif method=='POST' and path=='/start':
            spec=json.loads(body)
            if spec['id'] in jobs:status=409;result={'error':'duplicate'}
            elif time.time()>=deadline or spec['concurrency']>5000 or spec['users']>5000:status=400;result={'error':'limit'}
            else:jobs[spec['id']]={'spec':spec,'state':'queued'};tasks[spec['id']]=asyncio.create_task(run(spec));result={'id':spec['id'],'started':True}
        elif path.startswith('/job/'):
            details=path.endswith('/details')
            job_id=path[5:-8] if details else path[5:]
            if details and job_id in tasks:await tasks[job_id]
            result=jobs.get(job_id,{'error':'not_found'})
            if not details:result={k:v for k,v in result.items() if k!='records'}
        elif path=='/stats':result={**total,'cpuSeconds':time.process_time(),'rssKb':resource.getrusage(resource.RUSAGE_SELF).ru_maxrss}
        else:status=404;result={'error':'not_found'}
        data=json.dumps(result).encode();writer.write(f'HTTP/1.1 {status} OK\r\nContent-Type: application/json\r\nContent-Length: {len(data)}\r\nConnection: close\r\n\r\n'.encode()+data);await writer.drain()
    except Exception:pass
    finally:
        writer.close()
        try:await writer.wait_closed()
        except Exception:pass

async def main():
    server=await asyncio.start_server(connection,os.environ.get('SCALE_BIND','0.0.0.0'),int(os.environ.get('SCALE_PORT','8080')),limit=32*1024*1024)
    print('READY',flush=True)
    async with server:await server.serve_forever()
asyncio.run(main())
