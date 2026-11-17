# -*-coding:utf-8 -*-
# shelter地理编码

"""
# @File       : 1_ShelterGeocode.py
# @software   : PyCharm  
# @Time       ：2024/6/4 10:18
# @Author     ：Wei Lyu
"""

import requests
import pandas as pd
import math
# import numpy as np

x_pi = 3.14159265358979324 * 3000.0 / 180.0
pi = 3.1415926535897932384626 # π
a = 6378245.0 # 长半轴
ee = 0.00669342162296594323  # 扁率

def transformlat(lng, lat):
    ret = -100.0 + 2.0 * lng + 3.0 * lat + 0.2 * lat * lat + \
          0.1 * lng * lat + 0.2 * math.sqrt(math.fabs(lng))
    ret += (20.0 * math.sin(6.0 * lng * pi) + 20.0 *
            math.sin(2.0 * lng * pi)) * 2.0 / 3.0
    ret += (20.0 * math.sin(lat * pi) + 40.0 *
            math.sin(lat / 3.0 * pi)) * 2.0 / 3.0
    ret += (160.0 * math.sin(lat / 12.0 * pi) + 320 *
            math.sin(lat * pi / 30.0)) * 2.0 / 3.0
    return ret


def transformlng(lng, lat):
    ret = 300.0 + lng + 2.0 * lat + 0.1 * lng * lng + \
          0.1 * lng * lat + 0.1 * math.sqrt(math.fabs(lng))
    ret += (20.0 * math.sin(6.0 * lng * pi) + 20.0 *
            math.sin(2.0 * lng * pi)) * 2.0 / 3.0
    ret += (20.0 * math.sin(lng * pi) + 40.0 *
            math.sin(lng / 3.0 * pi)) * 2.0 / 3.0
    ret += (150.0 * math.sin(lng / 12.0 * pi) + 300.0 *
            math.sin(lng / 30.0 * pi)) * 2.0 / 3.0
    return ret

def out_of_china(lng, lat):
    """
    判断是否在国内，不在国内不做偏移
    :param lng:
    :param lat:
    :return:
    """
    if lng < 72.004 or lng > 137.8347:
        return True
    if lat < 0.8293 or lat > 55.8271:
        return True
    return False

def gcj02towgs84(lng, lat):
    """
    GCJ02(火星坐标系)转GPS84
    :param lng:火星坐标系的经度
    :param lat:火星坐标系纬度
    :return:
    """
    if out_of_china(lng, lat):
        return lng, lat
    dlat = transformlat(lng - 105.0, lat - 35.0)
    dlng = transformlng(lng - 105.0, lat - 35.0)
    radlat = lat / 180.0 * pi
    magic = math.sin(radlat)
    magic = 1 - ee * magic * magic
    sqrtmagic = math.sqrt(magic)
    dlat = (dlat * 180.0) / ((a * (1 - ee)) / (magic * sqrtmagic) * pi)
    dlng = (dlng * 180.0) / (a / sqrtmagic * math.cos(radlat) * pi)
    mglat = lat + dlat
    mglng = lng + dlng
    return [lng * 2 - mglng, lat * 2 - mglat]


class GaodeGeo:
    def __init__(self):
        self.key = ''
    def requestApi(self, url):
        re = requests.get(url).json()
        return re

    def getGeoCode(self, address):
        url = f'https://restapi.amap.com/v3/geocode/geo?parameters&key={self.key}&address={address}'
        json_data = self.requestApi(url)
        if json_data['status'] == '1':
            location = json_data['geocodes'][0]['location']
            return location
        else:
            return '获取失败'


if __name__ == '__main__':

    path = r'D:\LW\ABM\Data\cities_21\shelter'
    outputPath = r'D:\LW\ABM\OutputData\cities_21'

    file = '城市避难场所质量统计-v17.xlsx'

    relation = pd.read_csv(outputPath + '\\' + 'cities21_pop_CH.csv', header=None, usecols=[0, 3], encoding='gbk')
    cities_cn = relation[0].tolist()

    df = pd.read_excel(path + '\\' + file, sheet_name='避难场所', header=0, dtype=object)

    gd = GaodeGeo()

    k = 0   # 记录调用次数
    for city in cities_cn:
        df1 = df[df['市'] == city]
        lngs = []
        lats = []
        # 填写结构化地址信息:省份＋城市＋区县＋城镇＋乡村＋街道＋门牌号码
        for i, r in df1.iterrows():
            prov = '' if type(r['省']) != str else r['省']
            city = '' if type(r['市']) != str else r['市']
            district = '' if type(r['区（县）']) != str else r['区（县）']
            street = '' if type(r['街道（镇）']) != str else r['街道（镇）']
            name = '' if type(r['场所名称']) != str else r['场所名称']
            address = '' if type(r['详细地址']) != str else r['详细地址']
            query = prov + city + district + street + address + name
            print(query)
            result = gd.getGeoCode(query).split(',')
            if result[0] == '获取失败':
                new_lng = -1
                new_lat = -1
            else:
                lng = float(result[0])
                lat = float(result[1])
                new_lng, new_lat = gcj02towgs84(lng, lat)
            lngs.append(new_lng)
            lats.append(new_lat)
            k += 1
            print(k, city, new_lng, new_lat)
        df1['lng'] = lngs
        df1['lat'] = lats
        df1.to_csv(outputPath + '\\' + city + '\\' + city + '_real_shelter.csv', index=False, header=True)
